const SENSITIVE_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key)$/i;
const SENSITIVE_FIELD = /^(api[_-]?key|access[_-]?token|auth[_-]?token|authorization|password|private[_-]?key)$/i;
const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{12,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{12,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+\/-]{8,}=*\b/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

function redactHeaders(headers) {
  return Object.fromEntries(Object.entries(headers || {}).map(([key, value]) => [
    key,
    SENSITIVE_HEADER.test(key) ? '[REDACTED]' : value,
  ]));
}

function redactCredentials(value) {
  if (Array.isArray(value)) return value.map(redactCredentials);
  if (typeof value === 'string') return redactText(value);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    SENSITIVE_FIELD.test(key) ? '[REDACTED]' : redactCredentials(item),
  ]));
}

function redactText(value) {
  return SECRET_PATTERNS.reduce((text, pattern) => text.replace(pattern, '[REDACTED]'), String(value));
}

function findSecrets(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return SECRET_PATTERNS.map((pattern) => { pattern.lastIndex = 0; return pattern.test(text) ? pattern.source : null; }).filter(Boolean);
}

module.exports = { findSecrets, redactCredentials, redactHeaders, redactText };
