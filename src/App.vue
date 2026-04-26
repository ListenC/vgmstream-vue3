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
        <button
          v-if="info && info.allTracks"
          @click="downloadAllTracks"
          class="download-link"
        >
          ⬇ 下载全部 WAV
        </button>
      </div>

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
    </div>

    <div v-if="info && info.allTracks && info.allTracks.length > 1" class="playlist-card">
      <h3>🎵 音频流列表（共 {{ info.allTracks.length }} 首）</h3>
      <div class="playlist-list">
        <div 
          v-for="(track, idx) in info.allTracks" 
          :key="idx" 
          class="playlist-item"
          :class="{ active: info.currentTrackIndex === idx }"
        >
          <span class="track-name">{{ track.displayName }}</span>
          <span class="track-actions">
            <button @click.stop="playTrack(idx)" class="btn-play-small">▶</button>
            <button @click.stop="downloadTrack(idx)" class="btn-download-small">⬇</button>
          </span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onUnmounted } from 'vue'
import { Filesystem, Directory } from '@capacitor/filesystem'
import { Capacitor } from '@capacitor/core'
import JSZip from 'jszip'

const isAndroidApp = Capacitor.getPlatform() === 'android'

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
const isManualPause = ref(false) // 🔥 加这一行

let audioContext = null
let sourceNodes = new Set()
let decodedBuffer = null
let audioContextStartTime = 0
let savedTime = 0
let workerWrapper = null
let playbackInterval = null
let currentTrackMeta = null  // 保存当前播放音频流的元数据（包括循环信息）

function getPlaybackTime() {
  if (isPlaying.value && audioContext) {
    let time = savedTime + (audioContext.currentTime - audioContextStartTime)
    
    // 根据当前音频流的元数据判断是否循环
    if (currentTrackMeta && currentTrackMeta.loopStart !== undefined && currentTrackMeta.loopEnd > currentTrackMeta.loopStart) {
      const loopStart = currentTrackMeta.loopStart
      const loopEnd = currentTrackMeta.loopEnd
      const loopLength = loopEnd - loopStart
      
      if (time > loopEnd) {
        time = ((time - loopStart) % loopLength) + loopStart
      }
    } else {
      // 非循环模式：确保时间不超过总时长
      if (info.value) {
        time = Math.min(time, info.value.duration)
      }
    }
    
    return time
  }
  // 暂停时，直接返回保存的时间（不要计算偏移）
  return savedTime
}

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
    throw new Error('Worker 路径全部失败:\n' + candidates.join('\n') + '\n\n错误:\n' + errors.join('\n'))
  }

  const workerPath = await resolveWorkerPath()
  console.log('[Worker] 创建:', workerPath)
  const worker = new Worker(workerPath, { type: 'classic' })

  let loaded = false
  let loadPromise = null
  let symbol = 0
  const events = new Map()

  // ✅ 发送业务消息（正常用）
  function send(subject, ...content) {
    return load().then(() => {
      return new Promise((resolve, reject) => {
        const id = ++symbol
        events.set(id, { resolve, reject })
        const transfer = content.flatMap(item => {
          if (item instanceof ArrayBuffer) return [item]
          if (ArrayBuffer.isView(item)) return [item.buffer]
          return []
        })
        worker.postMessage({ symbol: id, subject, content }, transfer)
      })
    })
  }

  // ✅ 修复版 load：独立监听，不与业务冲突！
  function load() {
    if (loaded) return Promise.resolve()
    if (loadPromise) return loadPromise

    console.log('[Worker] 等待初始化...')

    // 🔥 核心修复：只轮询 loaded 变量，不占用事件池
    loadPromise = new Promise((resolve) => {
      const check = () => {
        if (loaded) {
          console.log('[Worker] 加载成功！')
          resolve()
          return
        }
        setTimeout(check, 50)
      }
      check()
    })

    return loadPromise
  }

  // ✅ 修复版 message 监听：load 完全独立处理
  worker.addEventListener('message', (event) => {
    const data = event.data

    // ==============================================
    // 🔥 关键：load 消息单独处理，不进 events！
    // ==============================================
    if (data.subject === 'load') {
      loaded = true
      console.log('[Worker] 全局标记已加载')
      return
    }

    // 业务消息正常处理
    const key = data.symbol
    const cb = events.get(key)
    if (!cb) return
    events.delete(key)

    if (data.error) {
      cb.reject(new Error(data.error?.message || 'Worker 错误'))
    } else {
      cb.resolve(data.content)
    }
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
    } catch (e) {}
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

function parseVgmstreamMetadata(stdout) {
  const info = {}

  function match(re) {
    const m = stdout.match(re)
    return m ? m[1].trim() : undefined
  }

  function matchInt(re) {
    const v = match(re)
    return v !== undefined ? parseInt(v) : undefined
  }

  info.sampleRate = matchInt(/sample rate:\s*(\d+)/i)
  info.channels = matchInt(/channels:\s*(\d+)/i)

  info.channelMask = match(/channel mask:\s*([^\n]+)/i)

  info.numSamples = matchInt(/play duration:\s*(\d+)/i)
  info.durationText = match(/play duration:.*\(([^)]+)\)/i)

  info.totalSamples = matchInt(/stream total samples:\s*(\d+)/i)

  info.encoding = match(/encoding:\s*([^\n]+)/i)
  info.layout = match(/layout:\s*([^\n]+)/i)
  info.metadataSource = match(/metadata from:\s*([^\n]+)/i)

  info.bitrate = match(/bitrate:\s*([^\n]+)/i)

  info.streamCount = matchInt(/stream count:\s*(\d+)/i)
  info.streamIndex = matchInt(/stream index:\s*(\d+)/i)
  info.streamName = match(/stream name:\s*([^\n]+)/i)

  info.sampleType = match(/sample type:\s*([^\n]+)/i)

  const loopStart = matchInt(/loop start:\s*(\d+)/i)
  const loopEnd = matchInt(/loop end:\s*(\d+)/i)

  if (loopStart !== undefined) info.loopStart = loopStart
  if (loopEnd !== undefined) info.loopEnd = loopEnd

  return info
}

// 🔥 加载完成后后台预解码所有音频流
async function preDecodeAllTracks(tracks) {
  for (const track of tracks) {
    try {
      if (!track._decodedBuffer) {
        const wavUint8 = new Uint8Array(track.wavData)
        const ab = wavUint8.buffer.slice(wavUint8.byteOffset, wavUint8.byteOffset + wavUint8.byteLength)
        track._decodedBuffer = await audioContext.decodeAudioData(ab)
      }
    } catch (e) {}
  }
}

async function loadFile(file) {
  // 强制销毁旧音频缓存，防止叠加泄漏
  if(info.value?.allTracks){
    info.value.allTracks.forEach(track=>{
      track._decodedBuffer = null
      track.wavData = null
    })
  }
  decodedBuffer = null

  window._pendingFileData = null
  status.value = '正在加载并解析文件，请稍候...'
  error.value = ''
  info.value = null
  convertLog.value = ''

  stop()
  revokeWavUrl()

  try {
    const wrapper = await createWorkerWrapper()

    const originalBuffer = await file.arrayBuffer()

    // ✅ 关键：提前复制两个独立 buffer（避免 detached）
    const bufferForInfo = originalBuffer.slice(0)
    const bufferForConvert = originalBuffer.slice(0)

    // ===== 1. 获取流信息 =====
    status.value = '正在检测音频流...'

    const streamInfoResponse = await wrapper.send(
      'getStreamInfo',
      new Uint8Array(bufferForInfo),
      file.name
    )

    //console.log('[StreamInfo]', streamInfoResponse)

    const streamCount = streamInfoResponse.streamCount || 1
    const streamNames = streamInfoResponse.streamNames || []

    const allStreams = Array.from({ length: streamCount }, (_, i) => i)

    // ===== 2. 转换全部流 =====
    status.value = `正在转换全部 ${streamCount} 个音频流...`

    const response = await wrapper.send(
      'convertFile',
      new Uint8Array(bufferForConvert),
      file.name,
      allStreams
    )

    if (!response || !response.results || response.results.length === 0) {
      throw new Error('未收到转换后的音频数据')
    }

    // ===== 3. 解析所有轨道 metadata =====
    const allTracks = response.results.map((r) => {
      const meta = parseVgmstreamMetadata(r.stdout)

      const name =
        meta.streamName ||
        streamNames[r.streamIndex] ||
        `音频流 ${r.streamIndex + 1}`

      return {
        ...r,
        meta,
        displayName: name,
      }
    })

    //console.log('[Tracks]', allTracks)

    // ===== 4. 默认第一条 =====
    const first = allTracks[0]

    const wavUint8 = new Uint8Array(first.wavData)
    const arrayBuffer = wavUint8.buffer.slice(
      wavUint8.byteOffset,
      wavUint8.byteOffset + wavUint8.byteLength
    )

    // ===== 5. 解码 =====
    if (!audioContext) {
      audioContext = new (window.AudioContext || window.webkitAudioContext)()
    }

    decodedBuffer = await audioContext.decodeAudioData(arrayBuffer)

    const meta = first.meta || {}

    const sampleRate = meta.sampleRate ?? decodedBuffer.sampleRate
    const duration = meta.numSamples
      ? meta.numSamples / sampleRate
      : decodedBuffer.duration

    // ===== 6. 写入 info =====
    info.value = {
      name: file.name,
      streamname: first.displayName,

      sampleRate,
      channels: meta.channels ?? decodedBuffer.numberOfChannels,

      codec: meta.encoding || 'PCM',
      layout: meta.layout,
      bitrate: meta.bitrate,

      duration,

      loopEnabled: meta.loopStart !== undefined,
      loopStart: meta.loopStart ? meta.loopStart / sampleRate : 0,
      loopEnd: meta.loopEnd ? meta.loopEnd / sampleRate : duration,

      totalStreams: allTracks.length,
      allTracks,
      currentTrackIndex: 0,
    }

    // ===== 设置当前音频流的元数据 =====
    currentTrackMeta = {
      loopStart: meta.loopStart !== undefined ? (meta.loopStart / sampleRate) : undefined,
      loopEnd: meta.loopEnd ? meta.loopEnd / sampleRate : duration,
      duration
    }

    // ===== 7. 播放 URL =====
    wavUrl.value = URL.createObjectURL(
      new Blob([arrayBuffer], { type: 'audio/wav' })
    )

    downloadFilename.value = first.displayName + '.wav'

    status.value = `成功加载 ${allTracks.length} 个音频流`

        // ✅ 优化：后台异步预解码第一个轨道（不阻塞UI）
    // 其他轨道在用户播放时再解码
    if (allTracks[0] && !allTracks[0]._decodedBuffer && audioContext) {
      Promise.resolve().then(() => {
        const track = allTracks[0]
        if (track.wavData && audioContext) {
          const wavUint8 = new Uint8Array(track.wavData)
          const arrayBuffer = wavUint8.buffer.slice(
            wavUint8.byteOffset,
            wavUint8.byteOffset + wavUint8.byteLength
          )
          audioContext.decodeAudioData(arrayBuffer)
            .then(buffer => {
              track._decodedBuffer = buffer
              console.log('[预解码] 第一个轨道解码完成')
            })
            .catch(() => {})
        }
      })
    }

  } catch (err) {
    error.value = '解析失败：' + err.message
    console.error(err)
    status.value = ''
  }
}

// 🔧 关键：WAV时长解析函数（解决NaN）
function parseWavDuration(wavBytes) {
  if (wavBytes.length < 44) return 0
  // WAV文件头固定偏移：
  // 0x18: 采样率（4字节）
  // 0x1C: 字节率（4字节）
  // 0x28: 数据长度（4字节）
  const view = new DataView(wavBytes.buffer, wavBytes.byteOffset, wavBytes.byteLength)
  const sampleRate = view.getUint32(0x18, true)
  const byteRate = view.getUint32(0x1C, true)
  const dataLength = view.getUint32(0x28, true)

  if (!sampleRate || !byteRate || !dataLength) return 0

  const durationSeconds = dataLength / byteRate
  const minutes = Math.floor(durationSeconds / 60)
  const seconds = Math.floor(durationSeconds % 60)
  const ms = Math.round((durationSeconds % 1) * 1000)

  return `${minutes}:${seconds.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`
}

async function performConversion(fileBuffer, fileName, wrapper, streamIndices, streamNames = []) {
  try {
    status.value = `正在转换 ${streamIndices.length} 个音频流...`

    const safeBuf = fileBuffer.slice(0)

    const response = await wrapper.send(
      'convertFile',
      new Uint8Array(safeBuf),
      fileName,
      streamIndices
    )

    if (!response || !response.results || response.results.length === 0) {
      throw new Error('未收到转换后的音频数据')
    }

    // ✅ 给每条轨加显示名
    const allTracks = response.results.map((r) => {
      const name = r.name || streamNames[r.streamIndex] || `音频流 ${r.streamIndex + 1}`
      return {
        ...r,
        displayName: name,
      }
    })

    console.log(response)

    // ✅ 默认取第一条轨
    const firstResult = allTracks[0]

    // ✅ 正确处理 Uint8Array → ArrayBuffer（修复隐藏bug）
    const wavUint8 = new Uint8Array(firstResult.wavData)
    const arrayBuffer = wavUint8.buffer.slice(
      wavUint8.byteOffset,
      wavUint8.byteOffset + wavUint8.byteLength
    )

    // ✅ 解码音频
    if (!audioContext) {
      audioContext = new (window.AudioContext || window.webkitAudioContext)()
    }
    decodedBuffer = await audioContext.decodeAudioData(arrayBuffer)

    // ✅ 使用 worker 返回的结构化信息（不再解析 stdout）
    const metadata = firstResult.info || {}

    const sampleRate = metadata.sampleRate ?? decodedBuffer.sampleRate
    const channels = metadata.channels ?? decodedBuffer.numberOfChannels

    const duration = metadata.numSamples
      ? metadata.numSamples / sampleRate
      : decodedBuffer.duration

    const loopStart = metadata.loopStart !== undefined
      ? metadata.loopStart / sampleRate
      : 0

    const loopEnd = metadata.loopEnd !== undefined
      ? metadata.loopEnd / sampleRate
      : duration

    // ✅ 设置信息
    info.value = {
      name: fileName,
      streamname: firstResult.displayName,

      sampleRate,
      channels,
      codec: 'PCM',

      duration,

      loopEnabled: metadata.loopStart !== undefined,
      loopStart,
      loopEnd,

      totalStreams: allTracks.length,
      allTracks,
      currentTrackIndex: 0,
    }

    // ✅ 创建播放 URL
    wavUrl.value = URL.createObjectURL(
      new Blob([arrayBuffer], { type: 'audio/wav' })
    )

    downloadFilename.value = firstResult.displayName + '.wav'

    status.value = `成功转换全部 ${allTracks.length} 个音频流`

  } catch (err) {
    error.value = '转换失败：' + err.message
    console.error(err)
    status.value = ''
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

  isManualPause.value = false
  
  if (isPlaying.value) {
    pause()
  }

  try {
    // 如果还没有设置当前音频流元数据，则从 info.value 初始化
    if (!currentTrackMeta) {
      currentTrackMeta = {
        loopStart: info.value.loopEnabled ? info.value.loopStart : undefined,
        loopEnd: info.value.loopEnd,
        duration: info.value.duration
      }
    }

    if (!audioContext || audioContext.state === 'closed') {
      audioContext = new (window.AudioContext || window.webkitAudioContext)({
        latencyHint: 'playback'
      })
    }

    if (audioContext.state === 'suspended') {
      await audioContext.resume()
    }

    stopAllSources()
    const source = audioContext.createBufferSource()
    source.buffer = decodedBuffer
    source.connect(audioContext.destination)

    // 根据当前音频流的元数据判断是否循环
    const hasLoop = currentTrackMeta && currentTrackMeta.loopStart !== undefined
    if (hasLoop && currentTrackMeta.loopEnd > currentTrackMeta.loopStart) {
      source.loop = true
      source.loopStart = currentTrackMeta.loopStart
      source.loopEnd = currentTrackMeta.loopEnd
    } else {
      source.loop = false
    }

    sourceNodes.add(source)

    source.onended = () => {
      sourceNodes.delete(source)
      if (sourceNodes.size === 0) {
        if (isManualPause.value) {
          isManualPause.value = false
          return
        }
        isPlaying.value = false
        // 检查当前音频流是否有循环，如果没有则重置
        const hasLoop = currentTrackMeta && currentTrackMeta.loopStart !== undefined
        if (!hasLoop) {
          status.value = '播放结束'
          clearInterval(playbackInterval)
          savedTime = 0
          currentPlayTime.value = 0
          playbackProgress.value = 0
        }
      }
    }

    audioContextStartTime = audioContext.currentTime
    source.start(0, savedTime)
    
    isPlaying.value = true
    status.value = '播放中'

    clearInterval(playbackInterval)
    
    // ✅ 优化：根据音频时长动态调整刷新频率
    // 长音频刷新频率更低，减少 Vue 重新渲染
    const updateInterval = info.value.duration > 300 ? 300 : 
                          info.value.duration > 60 ? 200 : 100
    
    playbackInterval = setInterval(() => {
      const time = getPlaybackTime()
      currentPlayTime.value = Math.min(time, info.value.duration)
      playbackProgress.value = Math.min((time / info.value.duration) * 100, 100)
    }, updateInterval)
  } catch (err) {
    error.value = '播放失败：' + err.message
    console.error(err)
  }
}

function pause() {
  if (!isPlaying.value || sourceNodes.size === 0) return

  try {
    isManualPause.value = true
    clearInterval(playbackInterval)
    // 使用 getPlaybackTime() 正确计算当前位置（自动处理循环逻辑）
    savedTime = getPlaybackTime()
    
    // 直接停止所有源，不依赖 onended 事件
    sourceNodes.forEach((source) => {
      try {
        source.stop()
      } catch (e) {}
    })
    sourceNodes.clear()
    
    isPlaying.value = false
    currentPlayTime.value = savedTime
    playbackProgress.value = info.value ? (savedTime / info.value.duration) * 100 : 0
    status.value = '已暂停'

    if (info.value) {
      currentPlayTime.value = savedTime
      playbackProgress.value = (savedTime / info.value.duration) * 100
    }

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
    currentTrackMeta = null
    status.value = '处理中……'
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
  
  savedTime = newTime
  currentPlayTime.value = newTime
  playbackProgress.value = (newTime / info.value.duration) * 100
  
  if (wasPlaying) {
    play()
  }
}

function startDragSeek(event) {
  if (!info.value || !decodedBuffer) return
  
  const wasPlaying = isPlaying.value
  
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
    
    if (wasPlaying) {
      play()
    }
  }
  
  document.addEventListener('mousemove', onMouseMove)
  document.addEventListener('mouseup', onMouseUp)
}

async function downloadWav() {
  if (!wavUrl.value || !downloadFilename.value) return

  // 安卓逻辑
  if (isAndroidApp) {
    try {
      const res = await fetch(wavUrl.value)
      const buf = await res.arrayBuffer()
      const uint8 = new Uint8Array(buf)
      let binary = ''
      for (let i = 0; i < uint8.length; i++) {
        binary += String.fromCharCode(uint8[i])
      }
      const base64 = btoa(binary)

      await Filesystem.writeFile({
        path: downloadFilename.value,
        data: base64,
        directory: Directory.Documents,
        recursive: true
      })

      error.value = ''
      status.value = `已保存到 文档/${downloadFilename.value}`
    } catch (e) {
      console.error('安卓保存失败：', e)
      error.value = '安卓保存失败，请检查权限'
    }
    return
  }

  // ✅ 网页端：直接下载，不读取、不解析、不阻塞！
  const a = document.createElement('a')
  a.href = wavUrl.value
  a.download = downloadFilename.value
  document.body.appendChild(a)
  a.click()

  setTimeout(() => {
    document.body.removeChild(a)
  }, 120)
}

async function downloadAllTracks() {
  if (!info.value || !info.value.allTracks) return

  const tracks = info.value.allTracks
  const originalFileName = info.value.name || "audio"
  const baseName = originalFileName.replace(/\.[^/.]+$/, "")

    // =========== 安卓版本 ===========
  if (isAndroidApp) {
    try {
      // ✅ 清理文件名：移除路径分隔符和非法字符
      const sanitizeFilename = (name) => {
        return name
          .replace(/[/\\:*?"<>|]/g, '_')  // 移除非法字符
          .replace(/_{2,}/g, '_')         // 合并多个下划线
          .trim()
      }

      status.value = "正在保存音频流..."
      for (const track of tracks) {
        const uint8 = new Uint8Array(track.wavData)
        let binary = ''
        for (let i = 0; i < uint8.length; i++) {
          binary += String.fromCharCode(uint8[i])
        }
        const base64 = btoa(binary)

        const filename = sanitizeFilename(track.displayName) + '.wav'

        await Filesystem.writeFile({
          path: filename,
          data: base64,
          directory: Directory.Documents,
          recursive: true
        })
      }
      error.value = ''
      status.value = `已保存 ${tracks.length} 个音频流到 文档 文件夹`
    } catch (e) {
      console.error('安卓保存失败：', e)
      error.value = '安卓保存失败：' + e.message
    }
    return
  }

  // =========== 网页版本 ===========
  if (tracks.length === 1) {
    // 单轨：直接下载
    status.value = "正在下载..."
    const track = tracks[0]
    const blob = new Blob([track.wavData], { type: "audio/wav" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = track.displayName + ".wav"
    document.body.appendChild(a)
    a.click()
    setTimeout(() => {
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      status.value = "下载完成"
    }, 120)
    return
  }

  // 多轨：打包 ZIP
  status.value = "正在生成 ZIP 压缩包..."
  const zip = new JSZip()
  for (const track of tracks) {
    const name = track.displayName + ".wav"
    zip.file(name, track.wavData)
  }

  const zipBlob = await zip.generateAsync({
    type: "blob",
    compression: "STORE"
  })

  const zipUrl = URL.createObjectURL(zipBlob)
  const a = document.createElement("a")
  a.href = zipUrl
  a.download = baseName + ".zip"
  document.body.appendChild(a)
  a.click()

  setTimeout(() => {
    document.body.removeChild(a)
    URL.revokeObjectURL(zipUrl)
    status.value = "ZIP 下载完成"
  }, 100)  // ✅ 从 200 改为 100，更快释放内存
}

async function playTrack(index) {
  if (!info.value || !info.value.allTracks) return

  const track = info.value.allTracks[index]
  if (!track) return

  stop()

  try {
    // ==========================================
    // ✅ 优化：如果已经解码过，直接用，不重新解码！
    // ==========================================
    if (!track._decodedBuffer) {
      const wavUint8 = new Uint8Array(track.wavData)
      const arrayBuffer = wavUint8.buffer.slice(
        wavUint8.byteOffset,
        wavUint8.byteOffset + wavUint8.byteLength
      )

      if (!audioContext || audioContext.state === 'closed') {
        audioContext = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'playback' })
      }
      if (audioContext.state === 'suspended') {
        await audioContext.resume()
      }

      // ✅ 只解码一次，缓存起来
      track._decodedBuffer = await audioContext.decodeAudioData(arrayBuffer)
    }

    // ✅ 直接用缓存，不卡！
    decodedBuffer = track._decodedBuffer

    // ===== 解析元数据 =====
    const meta = parseVgmstreamMetadata(track.stdout)
    const sampleRate = meta.sampleRate ?? decodedBuffer.sampleRate
    const duration = meta.numSamples ? meta.numSamples / sampleRate : decodedBuffer.duration
    const loopStart = meta.loopStart !== undefined ? meta.loopStart / sampleRate : 0
    const loopEnd = meta.loopEnd !== undefined ? meta.loopEnd / sampleRate : duration

    // ===== 更新界面 =====
    info.value = {
      ...info.value,
      currentTrackIndex: index,
      streamname: track.displayName,
      sampleRate,
      channels: meta.channels ?? decodedBuffer.numberOfChannels,
      codec: meta.encoding || 'PCM',
      layout: meta.layout,
      bitrate: meta.bitrate,
      duration,
      loopEnabled: meta.loopStart !== undefined,
      loopStart,
      loopEnd,
    }

    // ===== 设置当前音频流的元数据 =====
    currentTrackMeta = {
      loopStart: meta.loopStart !== undefined ? loopStart : undefined,
      loopEnd,
      duration
    }

    // ===== 播放 =====
    revokeWavUrl()
    wavUrl.value = URL.createObjectURL(
      new Blob([new Uint8Array(track.wavData)], { type: 'audio/wav' })
    )
    downloadFilename.value = track.displayName + '.wav'

    savedTime = 0
    currentPlayTime.value = 0
    playbackProgress.value = 0

    play()

  } catch (err) {
    console.error(err)
    error.value = '切换音频流失败：' + err.message
  }
}

async function downloadTrack(index) {
  if (!info.value || !info.value.allTracks) return
  const track = info.value.allTracks[index]
  if (!track) return

  // ✅ 清理文件名：移除路径分隔符和非法字符
  const sanitizeFilename = (name) => {
    return name
      .replace(/[/\\:*?"<>|]/g, '_')  // 移除非法字符
      .replace(/_{2,}/g, '_')         // 合并多个下划线
      .trim()
  }

  const wavUint8 = new Uint8Array(track.wavData)
  const arrayBuffer = wavUint8.buffer.slice(0)
  const filename = sanitizeFilename(track.displayName) + '.wav'

  // =========== 安卓版本 ===========
  if (isAndroidApp) {
    try {
      status.value = "正在保存..."
      const uint8 = new Uint8Array(track.wavData)
      let binary = ''
      for (let i = 0; i < uint8.length; i++) {
        binary += String.fromCharCode(uint8[i])
      }
      const base64 = btoa(binary)

      await Filesystem.writeFile({
        path: filename,
        data: base64,
        directory: Directory.Documents,
        recursive: true
      })

      error.value = ''
      status.value = `已保存到 文档/${filename}`
    } catch (e) {
      console.error('安卓保存失败：', e)
      error.value = '安卓保存失败：' + e.message
    }
    return
  }

  // =========== 网页版本 ===========
  const blob = new Blob([arrayBuffer], { type: 'audio/wav' })
  const url = URL.createObjectURL(blob)

  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  setTimeout(() => {
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }, 80)
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

.playback-progress {
  margin: 20px 0;
  padding: 14px;
  background: #f0fdf4;
  border-radius: 10px;
  border-left: 4px solid #10b981;
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

.playlist-card {
  margin-top: 24px;
  padding: 20px;
  border-radius: 12px;
  background: #f8fafc;
  border: 1px solid #e2e8f0;
}

.playlist-card h3 {
  margin: 0 0 16px;
  font-size: 1.2rem;
  color: #1e293b;
}

.playlist-list {
  max-height: 300px;
  overflow-y: auto;
  overflow-x: auto;
  border-radius: 8px;
  background: white;
  border: 1px solid #e2e8f0;
  -webkit-overflow-scrolling: touch;
}

.playlist-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  border-bottom: 1px solid #f1f5f9;
  cursor: pointer;
  transition: background 0.2s;
  min-width: 0;
}

.playlist-item:last-child {
  border-bottom: none;
}

.playlist-item:hover {
  background: #f1f5f9;
}

.playlist-item.active {
  background: #dbeafe;
}

.track-name {
  font-size: 0.95rem;
  color: #1e293b;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
  min-width: 0;
  margin-right: 12px;
}

.track-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

.btn-play-small, .btn-download-small {
  border: none;
  padding: 6px 10px;
  border-radius: 6px;
  font-size: 0.8rem;
  cursor: pointer;
}

.btn-play-small {
  background: #3b82f6;
  color: white;
}

.btn-download-small {
  background: #10b981;
  color: white;
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

  .playlist-list {
    max-height: 250px;
  }

  .track-name {
    font-size: 0.9rem;
  }

  .btn-play-small, .btn-download-small {
    padding: 5px 8px;
    font-size: 0.85rem;
  }
}
</style>