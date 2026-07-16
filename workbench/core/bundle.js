const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { SCHEMA_VERSION } = require('./event-schema');
const { readEvents, replaceEvents } = require('./event-store');
const { hashFile, sha256 } = require('./hashing');
const { redactCredentials } = require('./redaction');

function buildBundle(sessionDir, config, diagnostics) {
  const { events, errors } = readEvents(sessionDir);
  const safeEvents = redactCredentials(events);
  const eventsText = safeEvents.length ? `${safeEvents.map(JSON.stringify).join('\n')}\n` : '';
  const models = [...new Set(events.map((event) => event.model).filter(Boolean))];
  const protocols = [...new Set(events.map((event) => event.content?.protocol).filter(Boolean))];
  const manifest = {
    bundle_version: '1.0', schema_version: SCHEMA_VERSION, session_id: config.id || path.basename(sessionDir),
    created_at: new Date().toISOString(), agent_adapter: config.agent || inferAgent(events),
    protocol_adapters: protocols, models, source_parse_errors: errors.length, redacted: true,
  };
  const hashes = { 'events.jsonl': sha256(eventsText), 'diagnostics.json': sha256(diagnostics) };
  const zip = new AdmZip();
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)));
  zip.addFile('events.jsonl', Buffer.from(eventsText));
  zip.addFile('diagnostics.json', Buffer.from(JSON.stringify(diagnostics, null, 2)));
  const captureFile = path.join(sessionDir, 'gateway-capture.jsonl');
  if (fs.existsSync(captureFile)) {
    const safeCapture = sanitizeJsonl(captureFile);
    zip.addFile('raw/gateway-capture.redacted.jsonl', Buffer.from(safeCapture));
    hashes['raw/gateway-capture.redacted.jsonl'] = sha256(safeCapture);
  }
  const interceptFile = path.join(sessionDir, 'https-intercepts.json');
  if (fs.existsSync(interceptFile)) {
    let safe = {};
    try { safe = redactCredentials(JSON.parse(fs.readFileSync(interceptFile, 'utf8'))); } catch { safe = { error: 'Legacy intercept file could not be parsed' }; }
    const text = JSON.stringify(safe, null, 2);
    zip.addFile('raw/legacy-intercepts.redacted.json', Buffer.from(text));
    hashes['raw/legacy-intercepts.redacted.json'] = sha256(text);
  }
  zip.addFile('hashes.json', Buffer.from(JSON.stringify(hashes, null, 2)));
  return { buffer: zip.toBuffer(), manifest, hashes };
}

function importBundle(buffer, sessionDir) {
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries();
  if (entries.length > 64) throw new Error('Bundle contains too many entries');
  let totalSize = 0;
  for (const entry of entries) {
    const normalized = entry.entryName.replace(/\\/g, '/');
    if (normalized.startsWith('/') || normalized.includes('../')) throw new Error(`Unsafe bundle entry: ${entry.entryName}`);
    totalSize += Number(entry.header?.size || 0);
    if (totalSize > 512 * 1024 * 1024) throw new Error('Bundle uncompressed size exceeds limit');
  }
  const manifest = readZipJson(zip, 'manifest.json');
  const hashes = readZipJson(zip, 'hashes.json');
  const eventsEntry = zip.getEntry('events.jsonl');
  if (!manifest || !hashes || !eventsEntry) throw new Error('Bundle is missing manifest.json, hashes.json or events.jsonl');
  const eventsText = eventsEntry.getData().toString('utf8');
  if (hashes['events.jsonl'] !== sha256(eventsText)) throw new Error('events.jsonl hash mismatch');
  const events = eventsText.split(/\r?\n/).filter(Boolean).map((line, index) => { try { return JSON.parse(line); } catch { throw new Error(`Invalid events.jsonl line ${index + 1}`); } });
  fs.mkdirSync(sessionDir, { recursive: true });
  replaceEvents(sessionDir, events, { allowUnknown: true });
  fs.writeFileSync(path.join(sessionDir, 'bundle-manifest.json'), JSON.stringify(manifest, null, 2));
  return { manifest, events: events.length };
}

function sanitizeJsonl(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => {
    try { return JSON.stringify(redactCredentials(JSON.parse(line))); } catch { return JSON.stringify({ error: 'Unparseable capture record omitted' }); }
  }).join('\n') + '\n';
}

function readZipJson(zip, name) {
  const entry = zip.getEntry(name);
  return entry ? JSON.parse(entry.getData().toString('utf8')) : null;
}

function inferAgent(events) { return events.find((event) => event.agent && event.agent !== 'unknown')?.agent || 'unknown'; }

module.exports = { buildBundle, importBundle, sanitizeJsonl };
