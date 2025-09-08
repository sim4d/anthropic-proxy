
import { test } from 'node:test'
import { ok, deepStrictEqual } from 'node:assert'
import Fastify from 'fastify'
import indexModule from '../index.js'

// Mock the fetch function globally for testing
global.fetch = async (url, options) => {
    // Simulate a basic OpenAI stream response for "hello world"
    if (url.includes('/v1/chat/completions') && options.body.includes('"stream":true')) {
        return new Response(new ReadableStream({
            start(controller) {
                const encoder = new TextEncoder();
                controller.enqueue(encoder.encode('data: {"choices": [{"delta": {"content": "hello"}}]}

'));
                controller.enqueue(encoder.encode('data: {"choices": [{"delta": {"content": " world"}}]}

'));
                controller.enqueue(encoder.encode('data: [DONE]

'));
                controller.close();
            }
        }), {
            headers: { 'Content-Type': 'text/event-stream' }
        });
    }

    // Simulate a basic OpenAI non-stream response for "hello world"
    if (url.includes('/v1/chat/completions') && options.body.includes('"stream":false')) {
        return new Response(JSON.stringify({
            id: "chatcmpl-123",
            choices: [{
                message: { content: "Hello world non-stream" },
                finish_reason: "stop"
            }],
            usage: { prompt_tokens: 5, completion_tokens: 4 }
        }), {
            headers: { 'Content-Type': 'application/json' }
        });
    }

    // Default response for other fetches
    return new Response(JSON.stringify({ message: "Mocked fetch response" }), { status: 200 });
};

test('POST /v1/messages handles undefined message content gracefully in non-streaming mode', async (t) => {
    const fastify = Fastify();
    await fastify.register(indexModule);

    // Simulate a request where msg.content is undefined
    const response = await fastify.inject({
        method: 'POST',
        url: '/v1/messages',
        payload: {
            messages: [
                { role: 'user', content: 'Hello' },
                { role: 'assistant', content: undefined }, // This should not cause a split error
                { role: 'user', content: 'World' }
            ],
            stream: false,
        },
    });

    deepStrictEqual(response.statusCode, 200, 'Expected a 200 status code');
    const body = JSON.parse(response.payload);
    ok(body.usage, 'Expected usage field in response');
    ok(body.usage.input_tokens >= 0, 'Expected input_tokens to be a non-negative number');
    ok(body.usage.output_tokens >= 0, 'Expected output_tokens to be a non-negative number');
    ok(!body.error, 'Expected no error in response');
});

test('POST /v1/messages handles null message content gracefully in non-streaming mode', async (t) => {
    const fastify = Fastify();
    await fastify.register(indexModule);

    // Simulate a request where msg.content is null
    const response = await fastify.inject({
        method: 'POST',
        url: '/v1/messages',
        payload: {
            messages: [
                { role: 'user', content: 'Hello' },
                { role: 'assistant', content: null }, // This should not cause a split error
                { role: 'user', content: 'World' }
            ],
            stream: false,
        },
    });

    deepStrictEqual(response.statusCode, 200, 'Expected a 200 status code');
    const body = JSON.parse(response.payload);
    ok(body.usage, 'Expected usage field in response');
    ok(body.usage.input_tokens >= 0, 'Expected input_tokens to be a non-negative number');
    ok(!body.error, 'Expected no error in response');
});

test('POST /v1/messages handles undefined content in payload.system gracefully', async (t) => {
    const fastify = Fastify();
    await fastify.register(indexModule);

    // Simulate a request where payload.system.content is undefined
    const response = await fastify.inject({
        method: 'POST',
        url: '/v1/messages',
        payload: {
            system: [{ role: 'system', content: undefined }],
            messages: [{ role: 'user', content: 'Hello' }],
            stream: false,
        },
    });

    deepStrictEqual(response.statusCode, 200, 'Expected a 200 status code');
    const body = JSON.parse(response.payload);
    ok(!body.error, 'Expected no error in response');
});
