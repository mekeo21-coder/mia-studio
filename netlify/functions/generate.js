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
    const { prompt, apiKey, referenceImageUrl } = JSON.parse(event.body)
    if (!apiKey || !prompt) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing prompt or API key' }) }

    async function generateOne() {
      const payload = {
        model: 'image-01',
        prompt: prompt,
        aspect_ratio: '9:16',
        response_format: 'base64'
      }

      // Add subject reference if a face image is locked
      if (referenceImageUrl) {
        payload.subject_reference = [{
          type: 'character',
          image_file: referenceImageUrl
        }]
      }

      const res = await fetch('https://api.minimax.io/v1/image_generation', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + apiKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      })

      const data = await res.json()
      if (!res.ok) throw new Error(data.message || data.error || 'API error')

      const b64 = data.data && data.data.image_base64 && data.data.image_base64[0]
      if (!b64) throw new Error('No image in response')

      return 'data:image/jpeg;base64,' + b64
    }

    const results = await Promise.allSettled([
      generateOne(),
      generateOne(),
      generateOne(),
      generateOne()
    ])

    const output = results
      .filter(r => r.status === 'fulfilled' && r.value)
      .map(r => r.value)

    if (output.length === 0) throw new Error('All generations failed')

    return { statusCode: 200, headers, body: JSON.stringify({ output }) }

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) }
  }
}
