<template>
  <div class="app">
    <h1>vgmstream 离线播放器</h1>

    <div
      class="upload-box"
      @dragover.prevent="dragOver = true"
      @dragleave.prevent="dragOver = false"
      @drop.prevent="onDrop"
      :class="{ highlight: dragOver }"
    >
      <label class="file-label">
        <input type="file" @change="onFileSelected" />
        选择音频文件或拖拽到此处
      </label>
      <p class="hint">支持 .sab, .adx, .brstm, .hca, .vag 等多种 vgmstream 格式</p>
    </div>

    <div v-if="status" class="status">{{ status }}</div>
    <div v-if="error" class="error">{{ error }}</div>

    <!-- 转换进度条 -->
    <div v-if="isConverting" class="progress-container">
      <div class="progress-bar">
        <div class="progress-fill" :style="{ width: convertProgress + '%' }"></div>
      </div>
      <span class="progress-text">{{ convertProgress }}%</span>
    </div>

    <div v-if="info" class="info-card">
      <h3><span class="value">{{ info.name }} 音频信息</span></h3>
      <div class="meta-grid">
        <div class="meta-item">
          <span class="label">音频流</span>
          <span class="value">{{ info.streamname }}</span>
        </div>
        <div class="meta-item">
          <span class="label">采样率</span>
          <span class="value">{{ info.sampleRate }} Hz</span>
        </div>
        <div class="meta-item">
          <span class="label">声道数</span>
          <span class="value">{{ info.channels }}</span>
        </div>
        <div class="meta-item">
          <span class="label">编码格式</span>
          <span class="value">{{ info.codec }}</span>
        </div>
        <div class="meta-item">
          <span class="label">总时长</span>
          <span class="value">{{ formatTime(info.duration) }}</span>
        </div>
        <div class="meta-item">
          <span class="label">循环状态</span>
          <span class="value">{{ info.loopEnabled ? '✅ 开启' : '❌ 关闭' }}</span>
        </div>
      </div>

      <div v-if="info.loopEnabled" class="loop-info">
        <p>循环起点：{{ formatTime(info.loopStart) }}</p>
        <p>循环终点：{{ formatTime(info.loopEnd) }}</p>
      </div>

      <div class="controls">
        <button
          @click="play"
          :disabled="isPlaying || !decodedBuffer"
          class="primary"
        >
          ▶ 播放
        </button>
        <button @click="stop" :disabled="!isPlaying" class="secondary">
          ■ 停止
        </button>
        <button @click="pause" :disabled="!isPlaying" class="secondary">
          ⏸ 暂停
        </button>
        <a
          v-if="wavUrl"
          :href="wavUrl"
          :download="downloadFilename"
          class="download-link"
        >
          ⬇ 下载 WAV
        </a>
      </div>

      <!-- 播放进度条 -->
      <div v-if="isPlaying || decodedBuffer" class="playback-progress">
        <div
          class="progress-bar-playback"
          @click="seekPlayback"
          @mousedown="startDragSeek"
          :class="{ dragging: isDraggingSeek }"
        >
          <div class="progress-fill-playback" :style="{ width: playbackProgress + '%' }"></div>
          <div class="progress-handle" :style="{ left: playbackProgress + '%' }"></div>
        </div>
        <div class="time-display">
          <span class="current-time">{{ formatTime(currentPlayTime) }}</span>
          <span class="total-time">{{ formatTime(info.duration) }}</span>
        </div>
      </div>

      <div v-if="convertLog" class="log-card">
        <h4>vgmstream 输出</h4>
        <pre>{{ convertLog }}</pre>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onUnmounted } from 'vue'

const status = ref('')
const error = ref('')
const info = ref(null)
const isPlaying = ref(false)
const dragOver = ref(false)
const convertLog = ref('')
const wavUrl = ref('')
const downloadFilename = ref('')
const isConverting = ref(false)
const convertProgress = ref(0)
const currentPlayTime = ref(0)
const playbackProgress = ref(0)
const isDraggingSeek = ref(false)

let audioContext = null
let sourceNodes = new Set() // 所有source节点
let decodedBuffer = null
let audioContextStartTime = 0 // 记录AudioContext.currentTime
let savedTime = 0 // 保存的播放位置
let workerWrapper = null
let playbackInterval = null
let convertProgressInterval = null

// 计算当前播放时间，考虑循环逻辑
function getPlaybackTime() {
  if (isPlaying.value && audioContext) {
    let time = savedTime + (audioContext.currentTime - audioContextStartTime)
    
    // 处理循环播放的时间映射
    if (info.value && info.value.loopEnabled && info.value.loopEnd > info.value.loopStart) {
      const loopStart = info.value.loopStart
      const loopEnd = info.value.loopEnd
      const loopLength = loopEnd - loopStart
      
      // 当时间超过循环结束点时，映射回循环区间
      if (time > loopEnd) {
        // 计算超出部分相对于循环长度的位置
        time = ((time - loopStart) % loopLength) + loopStart
      }
    } else {
      // 非循环：限制在总时长内
      if (info.value) {
        time = Math.min(time, info.value.duration)
      }
    }
    
    return time
  }
  return savedTime
}

// 停止所有source节点
function stopAllSources() {
  sourceNodes.forEach((source) => {
    try {
      source.stop()
    } catch (e) {}
  })
  sourceNodes.clear()
}

function formatTime(seconds) {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  const ms = Math.floor((seconds % 1) * 1000)
  return `${m}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`
}

async function createWorkerWrapper() {
  if (workerWrapper) return workerWrapper

  async function resolveWorkerPath() {
    const base = document.baseURI || window.location.href

    const candidates = [
      './vgmstream/cli-worker.js',
      'vgmstream/cli-worker.js',
      '/vgmstream/cli-worker.js',
      new URL('./vgmstream/cli-worker.js', base).href,
      new URL('vgmstream/cli-worker.js', base).href,
      new URL('/vgmstream/cli-worker.js', base).href
    ]

    const errors = []

    for (const url of candidates) {
      try {
        const res = await fetch(url)
        if (res.ok) {
          console.log('[Worker] 使用路径:', url)
          return url
        }
        errors.push(`${url} -> ${res.status}`)
      } catch (e) {
        errors.push(`${url} -> ${e.message}`)
      }
    }

    throw new Error(
      'Worker 路径全部失败:\n' +
      candidates.join('\n') +
      '\n\n错误:\n' +
      errors.join('\n')
    )
  }

  const workerPath = await resolveWorkerPath()
  console.log('[Worker] 创建:', workerPath)

  const worker = new Worker(workerPath, { type: 'classic' })

  let loaded = false
  let loadPromise = null
  let symbol = 0
  let loadTimeout = null
  const events = new Map()

  function on(type) {
    return new Promise((resolve, reject) => {
      const cbs = events.get(type) || new Set()
      cbs.add({ resolve, reject })
      events.set(type, cbs)
    })
  }

  function send(subject, ...content) {
    return load().then(() => {
      return new Promise((resolve, reject) => {
        const id = ++symbol
        const cbs = events.get(id) || new Set()
        cbs.add({ resolve, reject })
        events.set(id, cbs)

        const transfer = content.flatMap((item) => {
          if (item instanceof ArrayBuffer) return [item]
          if (ArrayBuffer.isView(item)) return [item.buffer]
          return []
        })

        worker.postMessage(
          { symbol: id, subject, content },
          transfer
        )
      })
    })
  }

  function load() {
    if (loaded) return Promise.resolve()
    if (loadPromise) return loadPromise

    loadPromise = Promise.race([
      on('load'),
      new Promise((_, reject) => {
        loadTimeout = setTimeout(() => {
          reject(new Error('Worker 加载超时'))
        }, 30000)
      })
    ]).then((res) => {
      clearTimeout(loadTimeout)
      return res
    }).catch((err) => {
      loadPromise = null
      clearTimeout(loadTimeout)
      throw err
    })

    return loadPromise
  }

  worker.addEventListener('message', (event) => {
    const data = event.data

    // ==============================================
    // ✅ 终极兼容：强制处理 load 消息，安卓/网页双端通吃
    // ==============================================
    if (data.subject === 'load') {
      const cbs = events.get('load')
      if (cbs) {
        cbs.forEach(({ resolve }) => resolve())
        events.delete('load')
        loaded = true
        console.log('[Worker] 收到启动成功消息！')
        return
      }
    }

    const key = data.symbol || data.subject
    const cbs = events.get(key)
    if (!cbs) return

    cbs.forEach(({ resolve, reject }) => {
      if (data.error) {
        const err = new Error(data.error.message || 'Worker error')
        reject(err)
      } else {
        resolve(data.content)
      }
    })
    events.delete(key)
  })

  worker.addEventListener('error', (e) => {
    console.error('[Worker error]', e)
  })

  worker.addEventListener('messageerror', (e) => {
    console.error('[Worker messageerror]', e)
  })

  workerWrapper = { send, load }
  return workerWrapper
}

function parseMetadata(stdout, stderr) {
  if (!stdout) return null

  const lines = stdout
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line)
      if (parsed && typeof parsed === 'object') {
        return parsed
      }
    } catch (e) {
      // skip invalid JSON
    }
  }

  if (stderr) {
    const encoding = stderr.match(/encoding:\s*([^\n,]+)/i)?.[1] || 'Unknown'
    return { encoding }
  }

  return null
}

async function onFileSelected(event) {
  const file = event.target.files?.[0]
  if (!file) return
  await loadFile(file)
}

function onDrop(event) {
  dragOver.value = false
  const files = Array.from(event.dataTransfer?.files || [])
  if (files.length === 0) return
  loadFile(files[0])
}

async function loadFile(file) {
  status.value = '正在转换并解析文件...'
  error.value = ''
  info.value = null
  convertLog.value = ''
  stop()
  revokeWavUrl()

  isConverting.value = true
  convertProgress.value = 0

  // 模拟转换进度
  convertProgressInterval = setInterval(() => {
    if (convertProgress.value < 90) {
      convertProgress.value += Math.random() * 30
    }
  }, 200)

  try {
    const wrapper = await createWorkerWrapper()
    const fileBuffer = await file.arrayBuffer()

    const response = await wrapper.send(
      'convertFile',
      new Uint8Array(fileBuffer),
      file.name
    )

    convertProgress.value = 100
    clearInterval(convertProgressInterval)

    if (!response || !response.arrayBuffer) {
      throw new Error('未收到转换后的音频数据')
    }

    convertLog.value = (response.stderr || '').trim()

    const arrayBuffer = response.arrayBuffer
    audioContext = new (window.AudioContext || window.webkitAudioContext)({
      latencyHint: 'playback'
    })

    decodedBuffer = await audioContext.decodeAudioData(arrayBuffer.slice(0))

    const metadata = parseMetadata(response.stdout, response.stderr)
    const sampleRate = metadata?.sampleRate || decodedBuffer.sampleRate
    const numberOfSamples = metadata?.numberOfSamples || decodedBuffer.duration * sampleRate

    const loopStart =
      metadata?.loopingInfo?.start !== undefined ? metadata.loopingInfo.start : 0
    const loopEnd =
      metadata?.loopingInfo?.end !== undefined
        ? metadata.loopingInfo.end
        : numberOfSamples

    const loopEnabled =
      metadata?.loopingInfo?.start !== undefined &&
      metadata?.loopingInfo?.end !== undefined &&
      loopEnd > loopStart

    info.value = {
      name: file.name,
      sampleRate: sampleRate,
      channels: metadata?.channels || decodedBuffer.numberOfChannels,
      codec: metadata?.codec || metadata?.format || 'PCM',
      duration: numberOfSamples / sampleRate,
      loopEnabled,
      loopStart: loopStart / sampleRate,
      loopEnd: loopEnd / sampleRate,
      streamname: metadata?.streamInfo?.name || file.name
    }

    wavUrl.value = URL.createObjectURL(
      new Blob([arrayBuffer], { type: 'audio/wav' })
    )
    downloadFilename.value = file.name + '.wav'
    status.value = '解析完成，可以播放'
  } catch (err) {
    // 提供详细的错误诊断信息
    let errorMsg = err.message || String(err)
    if (errorMsg.includes('Worker') || errorMsg.includes('加载超时')) {
      errorMsg += '\n\n🔧 故障排查建议：\n' +
        '1. 确保 public/vgmstream/ 文件夹包含：\n' +
        '   - cli-worker.js\n' +
        '   - vgmstream-cli.js\n' +
        '   - vgmstream-cli.wasm\n' +
        '2. 重新运行 npm run build 或 npm run dev\n' +
        '3. 清除浏览器缓存并刷新页面\n' +
        '4. 打开浏览器控制台查看详细错误'
    }
    error.value = '解析失败：' + errorMsg
    console.error('Detailed error:', err)
    status.value = ''
  } finally {
    isConverting.value = false
    clearInterval(convertProgressInterval)
  }
}

function revokeWavUrl() {
  if (wavUrl.value) {
    URL.revokeObjectURL(wavUrl.value)
    wavUrl.value = ''
  }
}

async function play() {
  if (!decodedBuffer || !info.value) return
  
  // 如果已在播放，先暂停
  if (isPlaying.value) {
    pause()
  }

  try {
    // 初始化或恢复 AudioContext
    if (!audioContext || audioContext.state === 'closed') {
      audioContext = new (window.AudioContext || window.webkitAudioContext)({
        latencyHint: 'playback'
      })
    }

    if (audioContext.state === 'suspended') {
      await audioContext.resume()
    }

    // 停止所有旧的 source 节点
    stopAllSources()

    // 创建新的 source 节点
    const source = audioContext.createBufferSource()
    source.buffer = decodedBuffer
    source.connect(audioContext.destination)

    // 处理循环
    if (info.value.loopEnabled && info.value.loopEnd > info.value.loopStart) {
      source.loop = true
      source.loopStart = info.value.loopStart
      source.loopEnd = info.value.loopEnd
    } else {
      source.loop = false
    }

    // 添加到source集合
    sourceNodes.add(source)

    // 播放结束回调
    source.onended = () => {
      sourceNodes.delete(source)
      if (sourceNodes.size === 0) {
        isPlaying.value = false
        // 如果启用了循环，不重置，让用户手动停止或继续
        // 如果没有循环，重置为开始位置
        if (!info.value.loopEnabled) {
          status.value = '播放结束'
          clearInterval(playbackInterval)
          savedTime = 0
          currentPlayTime.value = 0
          playbackProgress.value = 0
        } else {
          status.value = '循环播放结束'
        }
      }
    }

    // 记录播放开始时间
    audioContextStartTime = audioContext.currentTime
    source.start(0, savedTime)
    
    isPlaying.value = true
    status.value = '播放中'

    // 更新播放进度
    clearInterval(playbackInterval)
    playbackInterval = setInterval(() => {
      const time = getPlaybackTime()
      currentPlayTime.value = Math.min(time, info.value.duration)
      playbackProgress.value = Math.min((time / info.value.duration) * 100, 100)
    }, 100)
  } catch (err) {
    error.value = '播放失败：' + err.message
    console.error(err)
  }
}

function pause() {
  if (!isPlaying.value || sourceNodes.size === 0) return

  try {
    clearInterval(playbackInterval)
    // 在停止前保存当前播放位置（使用getPlaybackTime获取映射后的实际位置）
    if (audioContext && audioContextStartTime !== undefined) {
      savedTime = getPlaybackTime()
    }
    // 停止所有source节点
    stopAllSources()
    isPlaying.value = false
    status.value = '已暂停'
  } catch (err) {
    console.error(err)
  }
}

function stop() {
  try {
    clearInterval(playbackInterval)
    stopAllSources()
    isPlaying.value = false
    savedTime = 0
    currentPlayTime.value = 0
    playbackProgress.value = 0
    status.value = '已停止'
  } catch (err) {
    console.error(err)
  }
}

function seekPlayback(event) {
  if (!info.value || !decodedBuffer) return
  
  const bar = event.currentTarget
  const rect = bar.getBoundingClientRect()
  const percent = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width))
  const newTime = Math.min(percent * info.value.duration, info.value.duration)
  
  const wasPlaying = isPlaying.value
  
  // 设置新的播放位置
  savedTime = newTime
  currentPlayTime.value = newTime
  playbackProgress.value = (newTime / info.value.duration) * 100
  
  // 如果之前在播放，继续播放
  if (wasPlaying) {
    play()
  }
}

function startDragSeek(event) {
  if (!info.value || !decodedBuffer) return
  
  const wasPlaying = isPlaying.value
  
  // 暂停当前播放
  if (isPlaying.value) {
    pause()
  }
  
  isDraggingSeek.value = true
  const progressBar = event.currentTarget
  
  function onMouseMove(moveEvent) {
    const rect = progressBar.getBoundingClientRect()
    const percent = Math.max(0, Math.min(1, (moveEvent.clientX - rect.left) / rect.width))
    const newTime = Math.min(percent * info.value.duration, info.value.duration)
    
    savedTime = newTime
    currentPlayTime.value = newTime
    playbackProgress.value = (newTime / info.value.duration) * 100
  }
  
  function onMouseUp() {
    isDraggingSeek.value = false
    document.removeEventListener('mousemove', onMouseMove)
    document.removeEventListener('mouseup', onMouseUp)
    
    // 如果之前在播放，继续播放
    if (wasPlaying) {
      play()
    }
  }
  
  document.addEventListener('mousemove', onMouseMove)
  document.addEventListener('mouseup', onMouseUp)
}

onUnmounted(() => {
  stop()
  revokeWavUrl()
})
</script>

<style scoped>
* {
  box-sizing: border-box;
}

.app {
  max-width: 800px;
  margin: 24px auto;
  padding: 0 20px 40px;
  font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont,
    "Segoe UI", Roboto, sans-serif;
  color: #1f2937;
  background-color: transparent;
}

h1 {
  margin: 0 0 24px;
  font-size: 2.5rem;
  text-align: center;
  color: #1e40af;
  font-weight: 700;
}

.upload-box {
  border: 3px dashed #3b82f6;
  border-radius: 24px;
  background: linear-gradient(135deg, rgba(59, 130, 246, 0.08), rgba(99, 102, 241, 0.04));
  padding: 40px 32px;
  transition: all 0.3s ease;
  text-align: center;
  cursor: pointer;
}

.upload-box:hover {
  border-color: #2563eb;
  background: rgba(59, 130, 246, 0.12);
}

.upload-box.highlight {
  border-color: #1d4ed8;
  background: rgba(37, 99, 235, 0.16);
}

.file-label {
  display: inline-flex;
  align-items: center;
  gap: 0.75rem;
  padding: 12px 28px;
  border-radius: 999px;
  background: linear-gradient(135deg, #3b82f6, #2563eb);
  color: #ffffff;
  cursor: pointer;
  font-weight: 700;
  user-select: none;
  transition: all 0.2s ease;
  box-shadow: 0 4px 15px rgba(59, 130, 246, 0.3);
}

.file-label:hover {
  transform: translateY(-2px);
  box-shadow: 0 6px 20px rgba(59, 130, 246, 0.4);
}

.upload-box input[type='file'] {
  display: none;
}

.hint {
  margin-top: 16px;
  color: #6b7280;
  font-size: 0.95rem;
  line-height: 1.5;
}

.status,
.error {
  margin-top: 20px;
  padding: 14px 18px;
  border-radius: 12px;
  font-weight: 600;
  text-align: center;
}

.status {
  background: #dbeafe;
  color: #1e40af;
  border: 1px solid #93c5fd;
}

.error {
  background: #fee2e2;
  color: #7f1d1d;
  border: 1px solid #fecaca;
}

.info-card {
  margin-top: 32px;
  padding: 28px;
  border-radius: 16px;
  border: 1px solid #e5e7eb;
  background: #ffffff;
  box-shadow: 0 10px 35px rgba(0, 0, 0, 0.08);
}

.info-card h3 {
  margin: 0 0 20px;
  font-size: 1.5rem;
  color: #1f2937;
  font-weight: 700;
}

.meta-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 18px;
  margin-bottom: 24px;
}

.meta-item {
  display: flex;
  flex-direction: column;
  padding: 14px;
  background: #f9fafb;
  border-radius: 10px;
  border-left: 4px solid #3b82f6;
}

.meta-item .label {
  font-size: 0.85rem;
  color: #6b7280;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.meta-item .value {
  font-size: 1.1rem;
  color: #1f2937;
  font-weight: 700;
  margin-top: 6px;
}

.loop-info {
  padding: 16px;
  margin-bottom: 24px;
  background: #fef3c7;
  border-left: 4px solid #f59e0b;
  border-radius: 8px;
}

.loop-info p {
  margin: 8px 0;
  color: #92400e;
  font-size: 0.95rem;
}

.controls {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 24px;
}

button,
.download-link {
  flex: 1;
  min-width: 140px;
  border: none;
  padding: 12px 20px;
  border-radius: 999px;
  font-weight: 700;
  font-size: 1rem;
  cursor: pointer;
  transition: all 0.2s ease;
  text-decoration: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

button:hover:not(:disabled),
.download-link:hover {
  transform: translateY(-2px);
}

button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.primary {
  background: linear-gradient(135deg, #3b82f6, #2563eb);
  color: #ffffff;
  box-shadow: 0 4px 15px rgba(59, 130, 246, 0.3);
}

.primary:hover:not(:disabled) {
  box-shadow: 0 6px 25px rgba(59, 130, 246, 0.4);
}

.secondary {
  background: #e5e7eb;
  color: #374151;
}

.secondary:hover:not(:disabled) {
  background: #d1d5db;
}

.download-link {
  background: linear-gradient(135deg, #10b981, #059669);
  color: #ffffff;
  box-shadow: 0 4px 15px rgba(16, 185, 129, 0.3);
}

.download-link:hover {
  box-shadow: 0 6px 25px rgba(16, 185, 129, 0.4);
}

.log-card {
  margin-top: 24px;
  padding: 16px;
  border-radius: 12px;
  background: #f3f4f6;
  border: 1px solid #d1d5db;
}

.log-card h4 {
  margin: 0 0 12px;
  font-size: 0.95rem;
  color: #374151;
  font-weight: 700;
}

.log-card pre {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  color: #1f2937;
  font-size: 0.85rem;
  line-height: 1.4;
  max-height: 200px;
  overflow-y: auto;
}

.progress-container {
  margin: 20px 0;
  padding: 14px;
  background: #f0f9ff;
  border-radius: 10px;
  border-left: 4px solid #3b82f6;
}

.progress-container label {
  display: block;
  font-weight: 600;
  color: #1e40af;
  font-size: 0.9rem;
  margin-bottom: 10px;
}

.progress-bar {
  width: 100%;
  height: 8px;
  background: #dbeafe;
  border-radius: 4px;
  overflow: hidden;
  box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.1);
}

.progress-fill {
  height: 100%;
  background: linear-gradient(90deg, #3b82f6 0%, #2563eb 100%);
  transition: width 0.1s linear;
  border-radius: 4px;
  box-shadow: 0 0 8px rgba(59, 130, 246, 0.6);
}

.playback-progress {
  margin: 20px 0;
  padding: 14px;
  background: #f0fdf4;
  border-radius: 10px;
  border-left: 4px solid #10b981;
}

.playback-progress label {
  display: block;
  font-weight: 600;
  color: #065f46;
  font-size: 0.9rem;
  margin-bottom: 10px;
}

.progress-bar-playback {
  width: 100%;
  height: 6px;
  background: #d1fae5;
  border-radius: 3px;
  cursor: pointer;
  position: relative;
  overflow: visible;
  transition: height 0.2s;
  box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.1);
}

.progress-bar-playback:hover {
  height: 8px;
}

.progress-fill-playback {
  height: 100%;
  background: linear-gradient(90deg, #10b981 0%, #059669 100%);
  border-radius: 3px;
  position: relative;
  box-shadow: 0 0 8px rgba(16, 185, 129, 0.6);
}

.progress-handle {
  position: absolute;
  width: 14px;
  height: 14px;
  background: #ffffff;
  border: 2px solid #10b981;
  border-radius: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  cursor: grab;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  transition: box-shadow 0.2s, transform 0.2s;
}

.progress-handle:hover {
  box-shadow: 0 2px 12px rgba(16, 185, 129, 0.6);
  transform: translate(-50%, -50%) scale(1.1);
}

.progress-handle:active {
  cursor: grabbing;
}

.time-display {
  display: flex;
  justify-content: space-between;
  margin-top: 8px;
  font-size: 0.85rem;
  color: #6b7280;
  font-family: 'Courier New', monospace;
}

@media (max-width: 640px) {
  h1 {
    font-size: 1.75rem;
    margin-bottom: 16px;
  }

  .upload-box {
    padding: 32px 24px;
  }

  .info-card {
    padding: 20px;
  }

  .meta-grid {
    grid-template-columns: 1fr;
    gap: 14px;
  }

  .controls {
    flex-direction: column;
  }

  button,
  .download-link {
    min-width: auto;
  }
}
</style>
