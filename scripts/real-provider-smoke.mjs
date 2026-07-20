const enabled = process.env.RUN_REAL_PROVIDER_SMOKE === 'true';
const maximumCost = Number(process.env.LLM_SMOKE_MAX_COST_MINOR_UNITS);
const provider = process.env.LLM_SMOKE_PROVIDER;
const credential = process.env.LLM_SMOKE_CREDENTIAL;

if (!enabled) {
  throw new Error('Real-provider smoke is disabled. Set RUN_REAL_PROVIDER_SMOKE=true explicitly.');
}
if (!Number.isInteger(maximumCost) || maximumCost < 0 || maximumCost > 1) {
  throw new Error('LLM_SMOKE_MAX_COST_MINOR_UNITS must be an integer between 0 and 1.');
}
if (!['OPENAI', 'GEMINI'].includes(provider) || !credential || credential.length > 16_384) {
  throw new Error('LLM_SMOKE_PROVIDER and a bounded LLM_SMOKE_CREDENTIAL are required.');
}

const configuration =
  provider === 'OPENAI'
    ? {
        url: 'https://api.openai.com/v1/models',
        headers: { authorization: `Bearer ${credential}` },
      }
    : {
        url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1',
        headers: { 'x-goog-api-key': credential },
      };
const response = await fetch(configuration.url, {
  method: 'GET',
  headers: configuration.headers,
  redirect: 'error',
  signal: AbortSignal.timeout(10_000),
});
await response.body?.cancel();
if (!response.ok) throw new Error(`Provider metadata smoke failed with HTTP ${response.status}.`);
console.log(`${provider} metadata smoke passed without a generation request.`);
