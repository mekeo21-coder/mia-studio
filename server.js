require('dotenv').config()
const express = require('express')
const session = require('express-session')
const bcrypt = require('bcryptjs')
const Database = require('better-sqlite3')
const fetch = require('node-fetch')
const path = require('path')

const app = express()
const PORT = process.env.PORT || 3000

// Database setup
const db = new Database('mia.db')
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    plan TEXT DEFAULT 'free',
    minimax_key TEXT DEFAULT '',
    novita_key TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`)

// Create admin user if not exists
const adminEmail = process.env.ADMIN_EMAIL || 'admin@rekw.com'
const adminPass = process.env.ADMIN_PASSWORD || 'changeme123'
const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(adminEmail)
if (!existing) {
  const hashed = bcrypt.hashSync(adminPass, 10)
  db.prepare('INSERT INTO users (email, password, plan) VALUES (?, ?, ?)').run(adminEmail, hashed, 'pro')
  console.log(`Admin user created: ${adminEmail}`)
}

// Middleware
app.use(express.json({ limit: '50mb' }))
app.use(express.urlencoded({ extended: true }))
app.use(express.static(path.join(__dirname, 'public')))
app.use(session({
  secret: process.env.SESSION_SECRET || 'mia-studio-secret-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 7 * 24 * 60 * 60 * 1000 }
}))

// Auth middleware
function requireAuth(req, res, next) {
  if (req.session.userId) return next()
  res.redirect('/login')
}

// ============ ROUTES ============

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'index.html'))
})

app.get('/login', (req, res) => {
  if (req.session.userId) return res.redirect('/studio')
  res.sendFile(path.join(__dirname, 'views', 'login.html'))
})

app.post('/login', (req, res) => {
  const { email, password } = req.body
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email)
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.json({ error: 'Invalid email or password' })
  }
  req.session.userId = user.id
  req.session.email = user.email
  req.session.plan = user.plan
  res.json({ success: true })
})

app.get('/logout', (req, res) => {
  req.session.destroy()
  res.redirect('/login')
})

app.get('/studio', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'studio.html'))
})

app.post('/api/keys', requireAuth, (req, res) => {
  const { minimax_key, novita_key } = req.body
  db.prepare('UPDATE users SET minimax_key = ?, novita_key = ? WHERE id = ?')
    .run(minimax_key || '', novita_key || '', req.session.userId)
  res.json({ success: true })
})

app.get('/api/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT email, plan, minimax_key, novita_key FROM users WHERE id = ?').get(req.session.userId)
  res.json(user)
})

// ============ IMAGE GENERATION ============

app.post('/api/generate', requireAuth, async (req, res) => {
  const { prompt, model, ratio, faceUrl } = req.body
  const user = db.prepare('SELECT minimax_key, novita_key FROM users WHERE id = ?').get(req.session.userId)

  try {
    let imageUrl = null

    if (model === 'minimax') {
      const apiKey = user.minimax_key
      if (!apiKey) return res.json({ error: 'No MiniMax API key saved. Go to Settings.' })

      const payload = {
        model: 'image-01',
        prompt,
        aspect_ratio: ratio || '9:16',
        response_format: 'base64'
      }
      if (faceUrl) {
        payload.subject_reference = [{ type: 'character', image_file: faceUrl }]
      }

      const response = await fetch('https://api.minimax.io/v1/image_generation', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })
      const data = await response.json()
      const b64 = data.data?.image_base64?.[0]
      if (!b64) throw new Error(data.base_resp?.status_msg || 'No image returned from MiniMax')
      imageUrl = 'data:image/jpeg;base64,' + b64

    } else if (model === 'novita') {
      const apiKey = user.novita_key
      if (!apiKey) return res.json({ error: 'No NovitaAI API key saved. Go to Settings.' })

      const aspectMap = { '1:1': [512,512], '4:5': [512,640], '9:16': [512,912], '16:9': [912,512] }
      const [width, height] = aspectMap[ratio] || [512, 912]

      const startRes = await fetch('https://api.novita.ai/v3/async/txt2img', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          extra: { response_image_type: 'jpeg', enable_nsfw_detection: false, nsfw_detection_level: 0 },
          request: {
            model_name: 'realisticVisionV51_v51VAE_94301.safetensors',
            prompt, width, height,
            negative_prompt: 'ugly, deformed, blurry, low quality, watermark, text, bad anatomy',
            image_num: 1, steps: 25, seed: -1, clip_skip: 1,
            guidance_scale: 7, sampler_name: 'Euler a'
          }
        })
      })
      const startData = await startRes.json()
      if (!startData.task_id) throw new Error(JSON.stringify(startData))

      let attempts = 0
      while (attempts < 30) {
        await new Promise(r => setTimeout(r, 2000))
        const pollRes = await fetch(`https://api.novita.ai/v3/async/task-result?task_id=${startData.task_id}`, {
          headers: { 'Authorization': `Bearer ${apiKey}` }
        })
        const pollData = await pollRes.json()
        if (pollData.task?.status === 'TASK_STATUS_SUCCEED') {
          imageUrl = pollData.imgs?.[0]?.image_url || pollData.images?.[0]?.image_url
          break
        }
        if (pollData.task?.status === 'TASK_STATUS_FAILED') throw new Error('NovitaAI generation failed')
        attempts++
      }
      if (!imageUrl) throw new Error('NovitaAI timed out')
    }

    res.json({ url: imageUrl })

  } catch (err) {
    console.error('Generate error:', err.message)
    res.json({ error: err.message })
  }
})

// ============ VIDEO FACE SWAP ============

// Step 1 — Upload template video to NovitaAI, get video_assets_id
app.post('/api/video-upload', requireAuth, async (req, res) => {
  const { videoUrl } = req.body
  const user = db.prepare('SELECT novita_key FROM users WHERE id = ?').get(req.session.userId)
  const apiKey = user.novita_key
  if (!apiKey) return res.json({ error: 'No NovitaAI key saved. Add it in Settings.' })

  try {
    // Fetch the video file
    const videoRes = await fetch(videoUrl)
    if (!videoRes.ok) throw new Error('Could not fetch template video')
    const videoBuffer = await videoRes.buffer()
    const base64Video = videoBuffer.toString('base64')
    const mimeType = 'video/mp4'

    // Upload to NovitaAI assets
    const uploadRes = await fetch('https://api.novita.ai/v3/assets/video', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        video: `data:${mimeType};base64,${base64Video}`,
        video_type: mimeType
      })
    })
    const uploadData = await uploadRes.json()
    if (!uploadData.video_assets_id) throw new Error(JSON.stringify(uploadData))
    res.json({ video_assets_id: uploadData.video_assets_id })
  } catch (err) {
    console.error('Video upload error:', err.message)
    res.json({ error: err.message })
  }
})

// Step 2 — Start face swap task
app.post('/api/video-faceswap', requireAuth, async (req, res) => {
  const { video_assets_id, face_image_base64 } = req.body
  const user = db.prepare('SELECT novita_key FROM users WHERE id = ?').get(req.session.userId)
  const apiKey = user.novita_key
  if (!apiKey) return res.json({ error: 'No NovitaAI key saved.' })

  try {
    const swapRes = await fetch('https://api.novita.ai/v3/async/video-merge-face', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        extra: { response_video_type: 'mp4' },
        request: {
          video_assets_id,
          enable_restore: true,
          face_image_base64
        }
      })
    })
    const swapData = await swapRes.json()
    if (!swapData.task_id) throw new Error(JSON.stringify(swapData))
    res.json({ task_id: swapData.task_id })
  } catch (err) {
    console.error('Face swap error:', err.message)
    res.json({ error: err.message })
  }
})

// Step 3 — Poll task result
app.get('/api/video-result', requireAuth, async (req, res) => {
  const { task_id } = req.query
  const user = db.prepare('SELECT novita_key FROM users WHERE id = ?').get(req.session.userId)
  const apiKey = user.novita_key
  if (!apiKey) return res.json({ error: 'No NovitaAI key.' })

  try {
    const pollRes = await fetch(`https://api.novita.ai/v3/async/task-result?task_id=${task_id}`, {
      headers: { 'Authorization': `Bearer ${apiKey}` }
    })
    const pollData = await pollRes.json()
    const status = pollData.task?.status || 'TASK_STATUS_PENDING'

    if (status === 'TASK_STATUS_SUCCEED') {
      const videoUrl = pollData.videos?.[0]?.video_url || pollData.video_url
      res.json({ status, video_url: videoUrl })
    } else {
      res.json({ status })
    }
  } catch (err) {
    res.json({ status: 'TASK_STATUS_FAILED', error: err.message })
  }
})

app.listen(PORT, () => {
  console.log(`Mia Studio running on port ${PORT}`)
})
