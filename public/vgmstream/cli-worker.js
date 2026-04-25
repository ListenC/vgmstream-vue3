// 动态计算wasmDir路径，支持不同的部署方式（Web、Electron、Android）
var wasmDir = (function() {
  try {
    // Worker 中获取脚本 URL
    var workerUrl = self.location.href
    if (!workerUrl) throw new Error('Unable to get worker URL')
    
    // 从完整URL解析出目录路径
    var url = new URL(workerUrl)
    var pathname = url.pathname
    
    // 移除文件名部分，保留目录路径
    var lastSlash = pathname.lastIndexOf('/')
    if (lastSlash === -1) {
      // 如果没有路径分隔符，使用简单的相对路径
      return './vgmstream/'
    }
    
    var dirPath = pathname.substring(0, lastSlash + 1)
    
    // 返回完整的 WASM 目录路径
    return url.origin + dirPath
  } catch (e) {
    // 任何错误都回退到相对路径
    console.warn('Failed to compute wasmDir from self.location:', e)
    return './vgmstream/'
  }
})()

var stdoutBuffer = ''
var stderrBuffer = ''
var Module = {
  noInitialRun: true,
  locateFile: function(name) {
    return wasmDir + name
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
  var response
  try {
    response = await fetch(jsUrl)
  } catch (error) {
    console.error('Failed to fetch ' + jsUrl, error)
    return errorLoading(jsUrl)
  }
  if (!response.ok) {
    console.error('HTTP error loading ' + jsUrl + ': ' + response.status)
    return errorLoading(jsUrl)
  }

  var cliJs = await response.text()
  try {
    eval.call(null, cliJs)
  } catch (error) {
    console.error('Error evaluating vgmstream-cli.js', error)
    return errorLoading(jsUrl)
  }

  try {
    await new Promise(function(resolve, reject) {
      Module.onRuntimeInitialized = resolve
      Module.onAbort = reject
    })
  } catch (error) {
    console.error('WASM module initialization failed', error)
    return errorLoading(wasmDir + 'vgmstream-cli.wasm')
  }

  postMessage({ subject: 'load' })
}

function errorLoading(file) {
  console.error('Error loading ' + file + '. wasmDir=' + wasmDir)
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
