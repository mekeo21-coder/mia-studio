exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  }

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' }
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) }

  try {
    const { prompt, apiKey } = JSON.parse(event.body)
    if (!apiKey || !prompt) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing prompt or API key' }) }

    // Single test call first so we can see the raw response
    const res = await fetch('https://api.minimax.io/v1/image_generation', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'image-01',
        prompt: prompt,
        aspect_ratio: '9:16',
        response_format: 'base64'
      })
    })

    const raw = await res.text()

    // Return raw response so we can see exactly what MiniMax sends back
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ debug: true, status: res.status, raw: raw.slice(0, 2000) })
    }

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) }
  }
}
