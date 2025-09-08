// verify_fix.js
// A simple script to verify the fix for the 'split' issue

// Replicate the fixed normalizeContent function
const normalizeContentFixed = (content) => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(item => String(item.text || '')).join(' ');
  }
  return ''; // Return empty string instead of null
};

// Test cases
const testCases = [
  { input: 'Hello world', description: 'String input' },
  { input: ['Hello', 'world'], description: 'Array of strings (incorrect for this function)' },
  { input: [{ text: 'Hello' }, { text: 'world' }], description: 'Array of objects with text' },
  { input: [{ text: 'Hello' }, { text: undefined }], description: 'Array with undefined text' },
  { input: [{ text: 'Hello' }, { text: null }], description: 'Array with null text' },
  { input: [{ text: 'Hello' }, {}], description: 'Array with object missing text property' },
  { input: undefined, description: 'Undefined input' },
  { input: null, description: 'Null input' },
  { input: 123, description: 'Number input' },
  { input: {}, description: 'Object input' }
];

console.log('Testing normalizeContent function...\n');

testCases.forEach(({ input, description }) => {
  try {
    const result = normalizeContentFixed(input);
    console.log(`✓ ${description}:`);
    console.log(`  Input: ${JSON.stringify(input)}`);
    console.log(`  Output: "${result}" (type: ${typeof result})`);
    
    // Try to use split on the result to mimic the original error scenario
    const splitResult = result.split(' ').length;
    console.log(`  Split result length: ${splitResult}\n`);
  } catch (error) {
    console.error(`✗ ${description}:`);
    console.error(`  Input: ${JSON.stringify(input)}`);
    console.error(`  Error: ${error.message}\n`);
  }
});

console.log('Verification complete.');