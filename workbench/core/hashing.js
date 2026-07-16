const crypto = require('crypto');
const fs = require('fs');

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function sha256(value) {
  const input = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : stableStringify(value));
  return crypto.createHash('sha256').update(input).digest('hex');
}

function hashFile(file) {
  return fs.existsSync(file) ? sha256(fs.readFileSync(file)) : null;
}

module.exports = { hashFile, sha256, stableStringify };
