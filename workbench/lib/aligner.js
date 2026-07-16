function normalizeText(value) {
  return String(value || '').replace(/\r\n/g, '\n').trim();
}

function parseArguments(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function normalizeProxyTools(tools = []) {
  return tools.map((tool) => ({
    id: tool.id || '',
    name: tool.name || '',
    input: stable(parseArguments(tool.arguments ?? tool.input)),
  }));
}

function normalizeClientTools(tools = []) {
  return tools.map((tool) => ({
    id: tool.id || '',
    name: tool.name || '',
    input: stable(tool.input || {}),
  }));
}

function toolComparison(proxyTools, clientTools) {
  const left = normalizeProxyTools(proxyTools);
  const right = normalizeClientTools(clientTools);
  const namesMatch = JSON.stringify(left.map((tool) => tool.name)) === JSON.stringify(right.map((tool) => tool.name));
  const structureMatch = JSON.stringify(left) === JSON.stringify(right);
  return { namesMatch, structureMatch, proxy: left, client: right };
}

function textComparison(proxyText, clientText) {
  const left = normalizeText(proxyText);
  const right = normalizeText(clientText);
  if (!left || !right) return { comparable: false, exact: false, prefix: false };
  const length = Math.min(160, left.length, right.length);
  return {
    comparable: true,
    exact: left === right,
    prefix: left.slice(0, length) === right.slice(0, length),
  };
}

function alignRecords(proxyRecords, clientRounds, makeDetail) {
  const details = [];
  let cursor = 0;
  for (const proxy of proxyRecords) {
    let best = null;
    for (let index = cursor; index < clientRounds.length; index++) {
      const client = clientRounds[index];
      const text = textComparison(proxy.responseContent, client.assistantContent);
      const tools = toolComparison(proxy.responseToolCalls, client.toolUses);
      const hasTools = tools.proxy.length > 0 || tools.client.length > 0;
      const textCandidate = text.comparable && text.prefix && (!hasTools || tools.namesMatch);
      const toolOnlyCandidate = !normalizeText(proxy.responseContent)
        && !normalizeText(client.assistantContent)
        && hasTools
        && tools.structureMatch;
      if (textCandidate || toolOnlyCandidate) {
        const confidence = text.exact && tools.structureMatch ? 1
          : text.prefix && tools.structureMatch ? 0.97
            : text.prefix && tools.namesMatch ? 0.9
              : 0.85;
        best = { client, index, confidence };
        break;
      }
    }
    if (best) {
      cursor = best.index + 1;
      details.push(makeDetail(proxy, best.client, best.confidence));
    } else {
      details.push({ proxyIndex: proxy.seqIndex, clientRound: null, confidence: 0, checks: { matched: false } });
    }
  }
  return details;
}

module.exports = {
  alignRecords,
  normalizeClientTools,
  normalizeProxyTools,
  normalizeText,
  textComparison,
  toolComparison,
};
