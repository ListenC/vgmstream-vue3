// 动态计算 wasmDir 路径，支持不同的部署方式（Web、Electron、Android）
var wasmDir = (function() {
  try {
    // 获取 Worker 脚本本身的位置（相对可靠的方法）
    var workerUrl = self.location.href
    
    // 验证 URL 是否有效
    if (!workerUrl || workerUrl === 'blob:' || workerUrl.startsWith('blob:')) {
      throw new Error('Worker URL is not valid for WASM loading')
    }
    
    // 解析 URL 以获取目录部分
    try {
      var url = new URL(workerUrl)
      var pathname = url.pathname
      
      // 移除文件名，获取目录路径
      var lastSlash = pathname.lastIndexOf('/')
      if (lastSlash === -1) {
        throw new Error('Cannot parse pathname')
      }
      
      var dirPath = pathname.substring(0, lastSlash + 1)
      
      // 构建完整的 WASM 目录 URL
      var result = url.origin + dirPath
      console.log('Computed wasmDir:', result)
      return result
    } catch (parseError) {
      throw parseError
    }
  } catch (e) {
    // 任何错误都使用相对路径作为降级方案
    console.warn('Failed to compute wasmDir:', e)
    return './'
  }
})()

console.log('Using wasmDir:', wasmDir)

var stdoutBuffer = ''
var stderrBuffer = ''
var Module = {
  noInitialRun: true,
  locateFile: function(name) {
    var fullPath = wasmDir + name
    console.log('Locating file:', name, '-> ', fullPath)
    return fullPath
  },
  preRun: function() {
    FS.init(undefined, function(code) {
      if (code !== null) stdoutBuffer += String.fromCharCode(code)
    }, function(code) {
      if (code !== null) stderrBuffer += String.fromCharCode(code)
    })
  }
}

function cleanError(error) {
  var output = {
    name: error.name,
    message: error.message,
    stack: error.stack
  }
  for (var key in error) {
    output[key] = error[key]
  }
  return output
}

function writeFile(name, data) {
  var stream = FS.open(name, 'w+')
  FS.write(stream, data, 0, data.length, 0)
  FS.close(stream)
}

function readFile(name) {
  try {
    var stream = FS.open(name, 'r')
  } catch (e) {
    return null
  }
  var data = new Uint8Array(stream.node.usedBytes)
  FS.read(stream, data, 0, data.length, 0)
  FS.close(stream)
  return data
}

function deleteFile(name) {
  try {
    FS.unlink(name)
  } catch (e) {
    // ignore
  }
}

function vgmstream() {
  stdoutBuffer = ''
  stderrBuffer = ''
  var args = Array.prototype.slice.call(arguments)
  try {
    callMain(args)
  } catch (error) {
    error.type = 'wasm'
    throw error
  }
  var output = {
    stdout: stdoutBuffer,
    stderr: stderrBuffer
  }
  stdoutBuffer = ''
  stderrBuffer = ''
  return output
}

function getOutput(output, inputFilename, outputFilename) {
  if (output.error) {
    deleteFile(outputFilename)
    var error = output.error
    error.stdout = output.stdout
    error.stderr = output.stderr
    throw error
  }

  var wavData = readFile(outputFilename)
  if (!wavData) {
    var error = new Error('vgmstream: Unsupported file')
    error.stdout = output.stdout
    error.stderr = output.stderr
    throw error
  }

  deleteFile(outputFilename)
  output.inputFilename = inputFilename
  output.outputFilename = inputFilename + '.wav'
  output.arrayBuffer = wavData.buffer
  return output
}

function convertFile(data, inputFilename) {
  var outputFilename = '/' + Math.random() + 'output.wav'
  writeFile(inputFilename, data)
  var output = vgmstream('-I', '-o', outputFilename, '-i', inputFilename)
  deleteFile(inputFilename)
  return getOutput(output, inputFilename, outputFilename)
}

async function loadCli() {
  var jsUrl = wasmDir + 'vgmstream-cli.js'
  console.log('Starting to load vgmstream CLI from:', jsUrl)
  
  var response
  try {
    response = await fetch(jsUrl)
  } catch (error) {
    console.error('Fetch failed for ' + jsUrl, error)
    return errorLoading(jsUrl + ' (Fetch error: ' + error.message + ')')
  }
  
  if (!response.ok) {
    console.error('HTTP error loading ' + jsUrl + ': ' + response.status)
    return errorLoading(jsUrl + ' (HTTP ' + response.status + ')')
  }

  console.log('Successfully fetched vgmstream-cli.js, evaluating...')
  var cliJs = await response.text()
  try {
    eval.call(null, cliJs)
  } catch (error) {
    console.error('Error evaluating vgmstream-cli.js:', error)
    return errorLoading(jsUrl + ' (Eval error: ' + error.message + ')')
  }

  console.log('vgmstream-cli.js evaluated successfully, initializing WASM module...')
  try {
    await new Promise(function(resolve, reject) {
      var initTimeout = setTimeout(function() {
        reject(new Error('WASM module initialization timeout (10s)'))
      }, 10000)
      
      Module.onRuntimeInitialized = function() {
        clearTimeout(initTimeout)
        resolve()
      }
      Module.onAbort = function(error) {
        clearTimeout(initTimeout)
        reject(new Error('WASM module aborted: ' + error))
      }
    })
  } catch (error) {
    console.error('WASM module initialization failed:', error)
    return errorLoading(wasmDir + 'vgmstream-cli.wasm (Init error: ' + error.message + ')')
  }

  console.log('WASM module initialized successfully')
  postMessage({ subject: 'load' })
}

function errorLoading(file) {
  console.error('Error loading:', file)
  postMessage({ subject: 'load', error: 'Error loading ' + file })
}

async function messageEvent(data) {
  let output = null
  let error = null
  try {
    switch (data.subject) {
      case 'convertFile':
        output = convertFile(data.content[0], data.content[1])
        break
      default:
        error = new Error('Unknown message subject ' + data.subject)
    }
  } catch (e) {
    error = cleanError(e)
  }

  postMessage({
    symbol: data.symbol,
    subject: data.subject,
    content: output,
    error: error ? error : null
  }, output && output.arrayBuffer ? [output.arrayBuffer] : [])
}

addEventListener('message', function(event) {
  messageEvent(event.data)
})

loadCli()
