// Uniform API response format: { ok, data } / { ok, error: { code, message } }

function corsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function handlePreflight(req, res) {
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return true;
  }
  return false;
}

function ok(res, data = {}, opts = {}) {
  if (opts.cache) res.setHeader('Cache-Control', opts.cache);
  res.status(opts.status || 200).json({ ok: true, data });
}

function err(res, status, code, message) {
  res.status(status).json({ ok: false, error: { code, message } });
}

function methodNotAllowed(res) {
  res.status(405).end();
}

module.exports = { corsHeaders, handlePreflight, ok, err, methodNotAllowed };
