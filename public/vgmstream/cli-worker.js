var wasmDir = '/vgmstream/'

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
    return errorLoading(jsUrl)
  }
  if (!response.ok) {
    return errorLoading(jsUrl)
  }

  var cliJs = await response.text()
  try {
    eval.call(null, cliJs)
  } catch (error) {
    console.error(error)
    return errorLoading(jsUrl)
  }

  try {
    await new Promise(function(resolve, reject) {
      Module.onRuntimeInitialized = resolve
      Module.onAbort = reject
    })
  } catch (error) {
    console.error(error)
    return errorLoading(wasmDir + 'vgmstream-cli.wasm')
  }

  postMessage({ subject: 'load' })
}

function errorLoading(file) {
  postMessage({ subject: 'load', error: 'Error loading ' + file })
}

async function messageEvent(data) {
  var output
  var error
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
    error: error
  }, output && output.arrayBuffer ? [output.arrayBuffer] : [])
}

addEventListener('message', function(event) {
  messageEvent(event.data)
})

loadCli()
