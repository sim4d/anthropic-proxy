// Extract environment variables from the Worker context
let baseUrl, requiresApiKey, key, models

function initializeEnvironment(env) {
  //baseUrl = env.ANTHROPIC_PROXY_BASE_URL || 'https://openrouter.ai/api'
  baseUrl = env.ANTHROPIC_PROXY_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/models/'
  requiresApiKey = !env.ANTHROPIC_PROXY_BASE_URL
  key = requiresApiKey ? env.OPENROUTER_API_KEY : null
  const model = 'gemini-2.5-pro'
  models = {
    reasoning: env.REASONING_MODEL || model,
    completion: env.COMPLETION_MODEL || model,
  }
}

function debug(...args) {
  if (!globalThis.DEBUG) return
  console.log(...args)
}

// Helper function to send SSE events and flush immediately.
const sendSSE = (response, event, data) => {
  const sseMessage = `event: ${event}\n` +
                     `data: ${JSON.stringify(data)}\n\n`
  response.write(sseMessage)
}

function mapStopReason(finishReason) {
  switch (finishReason) {
    case 'tool_calls': return 'tool_use'
    case 'stop': return 'end_turn'
    case 'length': return 'max_tokens'
    default: return 'end_turn'
  }
}

async function handleMessages(request, env) {
  try {
    console.log('handleMessages called');
    console.log('Parsing request body...');
    const payload = await request.json()
    console.log('Request body parsed successfully');
    debug('Incoming payload:', payload);

    // Helper to normalize a message's content.
    // If content is a string, return it directly.
    // If it's an array (of objects with text property), join them.
    const normalizeContent = (content) => {
      if (typeof content === 'string') return content
      if (Array.isArray(content)) {
        return content.map(item => String(item.text || '')).join(' ')
      }
      return '' // Return empty string instead of null
    }

    // Build messages array for the OpenAI payload.
    // Start with system messages if provided.
    const messages = []
    if (payload.system && Array.isArray(payload.system)) {
      payload.system.forEach(sysMsg => {
        const normalized = normalizeContent(sysMsg.text || sysMsg.content)
        if (normalized) {
          messages.push({
            role: 'system',
            content: normalized
          })
        }
      })
    }
    // Then add user (or other) messages.
    if (payload.messages && Array.isArray(payload.messages)) {
      payload.messages.forEach(msg => {
        const toolCalls = (Array.isArray(msg.content) ? msg.content : []).filter(item => item.type === 'tool_use').map(toolCall => ({
          function: {
            type: 'function',
            id: toolCall.id,
            function: {
              name: toolCall.name,
              parameters: toolCall.input,
            },
          }
        }))
        const newMsg = { role: msg.role }
        const normalized = normalizeContent(msg.content)
        if (normalized) newMsg.content = normalized
        if (toolCalls.length > 0) newMsg.tool_calls = toolCalls
        if (newMsg.content || newMsg.tool_calls) messages.push(newMsg)

        if (Array.isArray(msg.content)) {
          const toolResults = msg.content.filter(item => item.type === 'tool_result')
          toolResults.forEach(toolResult => {
            messages.push({
              role: 'tool',
              content: toolResult.text || toolResult.content,
              tool_call_id: toolResult.tool_use_id,
            })
          })
        }
      })
    }

    // Prepare the OpenAI payload.
    // Helper function to recursively traverse JSON schema and remove format: 'uri'
    const removeUriFormat = (schema) => {
      if (!schema || typeof schema !== 'object') return schema;

      // If this is a string type with uri format, remove the format
      if (schema.type === 'string' && schema.format === 'uri') {
        const { format, ...rest } = schema;
        return rest;
      }

      // Handle array of schemas (like in anyOf, allOf, oneOf)
      if (Array.isArray(schema)) {
        return schema.map(item => removeUriFormat(item));
      }

      // Recursively process all properties
      const result = {};
      for (const key in schema) {
      if (key === 'properties' && typeof schema[key] === 'object') {
        result[key] = {};
        for (const propKey in schema[key]) {
          result[key][propKey] = removeUriFormat(schema[key][propKey]);
        }
      } else if (key === 'items' && typeof schema[key] === 'object') {
        result[key] = removeUriFormat(schema[key]);
      } else if (key === 'additionalProperties' && typeof schema[key] === 'object') {
        result[key] = removeUriFormat(schema[key]);
      } else if (['anyOf', 'allOf', 'oneOf'].includes(key) && Array.isArray(schema[key])) {
        result[key] = schema[key].map(item => removeUriFormat(item));
      } else {
        result[key] = removeUriFormat(schema[key]);
      }
      }
      return result;
    };

    const tools = (payload.tools || []).filter(tool => !['BatchTool'].includes(tool.name)).map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: removeUriFormat(tool.input_schema),
      },
    }))
    const openaiPayload = {
      model: payload.thinking ? models.reasoning : models.completion,
      messages,
      max_tokens: payload.max_tokens,
      temperature: payload.temperature !== undefined ? payload.temperature : 1,
      stream: payload.stream === true,
    }
    if (tools.length > 0) openaiPayload.tools = tools
    debug('OpenAI payload:', openaiPayload)

    const headers = {
      'Content-Type': 'application/json'
    }
    
    if (requiresApiKey) {
      headers['Authorization'] = `Bearer ${key}`
    }
    
    const openaiResponse = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(openaiPayload)
    });

    if (!openaiResponse.ok) {
      const errorDetails = await openaiResponse.text()
      return new Response(JSON.stringify({ error: errorDetails }), {
        status: openaiResponse.status,
        headers: { 'Content-Type': 'application/json' }
      })
    }

    // If stream is not enabled, process the complete response.
    if (!openaiPayload.stream) {
      const data = await openaiResponse.json()
      debug('OpenAI response:', data)
      if (data.error) {
        throw new Error(data.error.message)
      }

      // Add more detailed logging
      debug('Data structure:', {
        hasChoices: !!data.choices,
        choicesLength: data.choices ? data.choices.length : 0,
        firstChoice: data.choices ? data.choices[0] : null
      });

      const choice = data.choices[0]
      const openaiMessage = choice.message

      debug('OpenAI message:', openaiMessage);
      debug('Tool calls:', openaiMessage.tool_calls);

      // Map finish_reason to anthropic stop_reason.
      const stopReason = mapStopReason(choice.finish_reason)
      const toolCalls = openaiMessage.tool_calls || []

      // Create a message id; if available, replace prefix, otherwise generate one.
      const messageId = data.id
        ? data.id.replace('chatcmpl', 'msg')
        : 'msg_' + Math.random().toString(36).substr(2, 24)

      const anthropicResponse = {
        content: [
          {
            text: openaiMessage.content,
            type: 'text'
          },
          ...(toolCalls && Array.isArray(toolCalls) 
            ? toolCalls.map(toolCall => {
                // Add a check for toolCall.function.arguments
                const args = toolCall.function.arguments || '{}';
                return {
                  type: 'tool_use',
                  id: toolCall.id,
                  name: toolCall.function.name,
                  input: JSON.parse(args),
                };
              })
            : []),
        ],
        id: messageId,
        model: openaiPayload.model,
        role: openaiMessage.role,
        stop_reason: stopReason,
        stop_sequence: null,
        type: 'message',
        usage: {
          input_tokens: data.usage
            ? data.usage.prompt_tokens
            : messages.reduce((acc, msg) => acc + msg.content.split(' ').length, 0),
          output_tokens: data.usage
            ? data.usage.completion_tokens
            : openaiMessage.content.split(' ').length,
        }
      }

      return new Response(JSON.stringify(anthropicResponse), {
        headers: { 'Content-Type': 'application/json' }
      })
    }

    // Streaming response using Server-Sent Events.
    const { readable, writable } = new TransformStream()
    const writer = writable.getWriter()
    const encoder = new TextEncoder()

    // Create a unique message id.
    const messageId = 'msg_' + Math.random().toString(36).substr(2, 24)

    // Send initial SSE event for message start.
    const messageStart = `event: message_start\ndata: ${JSON.stringify({
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        model: openaiPayload.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      }
    })}\n\n`
    writer.write(encoder.encode(messageStart))

    // Send initial ping.
    const ping = `event: ping\ndata: ${JSON.stringify({ type: 'ping' })}\n\n`
    writer.write(encoder.encode(ping))

    // Prepare for reading streamed data.
    let accumulatedContent = ''
    let accumulatedReasoning = ''
    let usage = null
    let textBlockStarted = false
    let encounteredToolCall = false
    const toolCallAccumulators = {}  // key: tool call index, value: accumulated arguments string
    const decoder = new TextDecoder('utf-8')
    
    // Process the stream
    const reader = openaiResponse.body.getReader()
    let done = false

    while (!done) {
      const { value, done: doneReading } = await reader.read()
      done = doneReading
      if (value) {
        const chunk = decoder.decode(value)
        debug('OpenAI response chunk:', chunk)
        // OpenAI streaming responses are typically sent as lines prefixed with "data: "
        const lines = chunk.split('\n')

        for (const line of lines) {
          const trimmed = line.trim()
          if (trimmed === '' || !trimmed.startsWith('data:')) continue
          const dataStr = trimmed.replace(/^data:\s*/, '')
          if (dataStr === '[DONE]') {
            // Finalize the stream with stop events.
            if (encounteredToolCall) {
              for (const idx in toolCallAccumulators) {
                const contentBlockStop = `event: content_block_stop\ndata: ${JSON.stringify({
                  type: 'content_block_stop',
                  index: parseInt(idx, 10)
                })}\n\n`
                writer.write(encoder.encode(contentBlockStop))
              }
            } else if (textBlockStarted) {
              const contentBlockStop = `event: content_block_stop\ndata: ${JSON.stringify({
                type: 'content_block_stop',
                index: 0
              })}\n\n`
              writer.write(encoder.encode(contentBlockStop))
            }
            const messageDelta = `event: message_delta\ndata: ${JSON.stringify({
              type: 'message_delta',
              delta: {
                stop_reason: encounteredToolCall ? 'tool_use' : 'end_turn',
                stop_sequence: null
              },
              usage: usage
                ? { output_tokens: usage.completion_tokens }
                : { output_tokens: accumulatedContent.split(' ').length + accumulatedReasoning.split(' ').length }
            })}\n\n`
            writer.write(encoder.encode(messageDelta))
            
            const messageStop = `event: message_stop\ndata: ${JSON.stringify({
              type: 'message_stop'
            })}\n\n`
            writer.write(encoder.encode(messageStop))
            
            writer.close()
            return new Response(readable, {
              headers: {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive'
              }
            })
          }

          const parsed = JSON.parse(dataStr)
          if (parsed.error) {
            throw new Error(parsed.error.message)
          }
          
          // Capture usage if available.
          if (parsed.usage) {
            usage = parsed.usage
          }
          const delta = parsed.choices[0].delta
          if (delta && delta.tool_calls) {
            for (const toolCall of delta.tool_calls) {
              encounteredToolCall = true
              const idx = toolCall.index
              if (toolCallAccumulators[idx] === undefined) {
                toolCallAccumulators[idx] = ""
                const contentBlockStart = `event: content_block_start\ndata: ${JSON.stringify({
                  type: 'content_block_start',
                  index: idx,
                  content_block: {
                    type: 'tool_use',
                    id: toolCall.id,
                    name: toolCall.function.name,
                    input: {}
                  }
                })}\n\n`
                writer.write(encoder.encode(contentBlockStart))
              }
              const newArgs = toolCall.function.arguments || ""
              const oldArgs = toolCallAccumulators[idx]
              if (newArgs.length > oldArgs.length) {
                const deltaText = newArgs.substring(oldArgs.length)
                const contentBlockDelta = `event: content_block_delta\ndata: ${JSON.stringify({
                  type: 'content_block_delta',
                  index: idx,
                  delta: {
                    type: 'input_json_delta',
                    partial_json: deltaText
                  }
                })}\n\n`
                writer.write(encoder.encode(contentBlockDelta))
                toolCallAccumulators[idx] = newArgs
              }
            }
          } else if (delta && delta.content) {
            if (!textBlockStarted) {
              textBlockStarted = true
              const contentBlockStart = `event: content_block_start\ndata: ${JSON.stringify({
                type: 'content_block_start',
                index: 0,
                content_block: {
                  type: 'text',
                  text: ''
                }
              })}\n\n`
              writer.write(encoder.encode(contentBlockStart))
            }
            accumulatedContent += delta.content
            const contentBlockDelta = `event: content_block_delta\ndata: ${JSON.stringify({
              type: 'content_block_delta',
              index: 0,
              delta: {
                type: 'text_delta',
                text: delta.content
              }
            })}\n\n`
            writer.write(encoder.encode(contentBlockDelta))
          } else if (delta && delta.reasoning) {
            if (!textBlockStarted) {
              textBlockStarted = true
              const contentBlockStart = `event: content_block_start\ndata: ${JSON.stringify({
                type: 'content_block_start',
                index: 0,
                content_block: {
                  type: 'text',
                  text: ''
                }
              })}\n\n`
              writer.write(encoder.encode(contentBlockStart))
            }
            accumulatedReasoning += delta.reasoning
            const contentBlockDelta = `event: content_block_delta\ndata: ${JSON.stringify({
              type: 'content_block_delta',
              index: 0,
              delta: {
                type: 'thinking_delta',
                thinking: delta.reasoning
              }
            })}\n\n`
            writer.write(encoder.encode(contentBlockDelta))
          }
        }
      }
    }

    writer.close()
    return new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      }
    })
  } catch (err) {
    console.error('Error in handleMessages:', err)
    console.error('Error stack:', err.stack)
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    })
  }
}

export default {
  async fetch(request, env, ctx) {
    try {
      console.log('Fetch handler called:', request.method, request.url);
      // Initialize environment variables
      console.log('Initializing environment variables...');
      initializeEnvironment(env)
      console.log('Environment variables initialized');
      
      // Set debug flag from environment
      console.log('Setting debug flag...');
      globalThis.DEBUG = env.DEBUG === '1'
      console.log('Debug flag set');
      
      // Handle CORS preflight requests
      console.log('Checking for OPTIONS request...');
      if (request.method === 'OPTIONS') {
        console.log('Handling OPTIONS request');
        return new Response(null, {
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          }
        })
      }

      // Handle the main POST request to /v1/messages
      console.log('Checking for POST /v1/messages request...');
      console.log('Request URL:', request.url);
      // Check if the URL contains /v1/messages (accounting for query parameters)
      if (request.method === 'POST' && request.url.includes('/v1/messages')) {
        console.log('Calling handleMessages...');
        const result = await handleMessages(request, env);
        console.log('handleMessages completed');
        return result;
      }

      // Default response for other routes
      console.log('Returning default response');
      return new Response('Anthropic Proxy Worker is running', {
        headers: { 'Content-Type': 'text/plain' }
      })
    } catch (err) {
      console.error('Error in fetch handler:', err)
      console.error('Error stack:', err.stack)
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      })
    }
  }
}
