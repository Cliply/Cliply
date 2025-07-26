/**
 * server manager - manages embedded python server lifecycle
 * handles startup, health checks, and graceful shutdown
 */

const { spawn } = require("child_process")
const fs = require("fs").promises
const path = require("path")
const http = require("http")
const { APP_CONFIG, HTTP_CONFIG } = require("../utils/constants")

class ServerManager {
  constructor(eventEmitter) {
    this.eventEmitter = eventEmitter
    this.serverProcess = null
    this.isReady = false
    this.isDevelopment = process.env.NODE_ENV === "development"
    this.resourcesPath = null
    this.pythonPath = null
    this.serverScript = null
    this.healthCheckInterval = null
    this.startupTimeout = null
  }

  /**
   * initialize server manager with resource paths
   * @param {string} resourcesPath - path to app resources
   */
  async initialize(resourcesPath) {
    this.resourcesPath = resourcesPath

    if (this.isDevelopment) {
      // development: use virtual environment in python directory
      const pythonDir = path.join(resourcesPath, "python")
      const venvDir = path.join(pythonDir, "venv")

      if (process.platform === "win32") {
        this.pythonPath = path.join(venvDir, "Scripts", "python.exe")
      } else {
        this.pythonPath = path.join(venvDir, "bin", "python")
      }

      this.serverScript = path.join(pythonDir, "server.py")
    } else {
      // production: use embedded python
      const pythonRuntimeDir = path.join(
        resourcesPath,
        APP_CONFIG.PYTHON_RUNTIME.EMBEDDED_PYTHON_DIR
      )
      this.pythonPath = path.join(
        pythonRuntimeDir,
        APP_CONFIG.PYTHON_RUNTIME.EMBEDDED_PYTHON_EXE
      )

      // server script should be in the regular python directory in extraResources
      this.serverScript = path.join(resourcesPath, "python", "server.py")
    }


    await this.validatePythonEnvironment()
  }

  /**
   * validate python environment and dependencies
   */
  async validatePythonEnvironment() {
    try {
      // check if server script exists
      await fs.access(this.serverScript)
    } catch (error) {
      throw new Error(`Python environment validation failed: ${error.message}`)
    }
  }

  /**
   * start the python server
   * @returns {Promise<boolean>} success status
   */
  async startServer() {
    if (this.serverProcess) {
      return true
    }

    this.eventEmitter.emit("python:server:starting")

    try {
      // check and install dependencies if needed for cross-platform builds
      await this.ensureDependencies()

      // spawn python server process
      this.serverProcess = spawn(this.pythonPath, [this.serverScript], {
        cwd: path.dirname(this.serverScript),
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          PYTHONPATH: path.dirname(this.serverScript),
          PYTHONUNBUFFERED: "1" // ensure immediate output
        }
      })

      // set up process event handlers
      this.setupProcessHandlers()

      // start health check
      await this.waitForServerReady()

      this.eventEmitter.emit("python:server:ready")
      return true
    } catch (error) {
      console.error("failed to start python server:", error.message)
      this.eventEmitter.emit("python:server:error", error)
      return false
    }
  }

  /**
   * set up process event handlers
   */
  setupProcessHandlers() {
    if (!this.serverProcess) return

    let pythonOutput = ""
    let pythonErrors = ""

    this.serverProcess.stdout.on("data", (data) => {
      const output = data.toString().trim()
      pythonOutput += output + "\n"
    })

    this.serverProcess.stderr.on("data", (data) => {
      const error = data.toString().trim()
      pythonErrors += error + "\n"
      if (error) {
        console.error(`[Python Error] ${error}`)
      }
    })

    this.serverProcess.on("close", (code) => {

      // show detailed error info for debugging
      if (code !== 0 && code !== null) {

        // show user-friendly error with details
        const { dialog } = require("electron")
        const BrowserWindow = require("electron").BrowserWindow
        const windows = BrowserWindow.getAllWindows()

        if (windows.length > 0) {
          dialog.showErrorBox(
            "Python Server Error",
            `Python server crashed with exit code ${code}\n\nError details:\n${pythonErrors}\n\nOutput:\n${pythonOutput}`
          )
        }
      }

      this.serverProcess = null
      this.isReady = false
      this.stopHealthCheck()

      if (code !== 0 && code !== null) {
        this.eventEmitter.emit(
          "python:server:error",
          new Error(`Server exited with code ${code}: ${pythonErrors}`)
        )
      }
    })

    this.serverProcess.on("error", (error) => {
      console.error("python server process error:", error.message)

      // show detailed process error
      const { dialog } = require("electron")
      const BrowserWindow = require("electron").BrowserWindow
      const windows = BrowserWindow.getAllWindows()

      if (windows.length > 0) {
        dialog.showErrorBox(
          "Python Process Error",
          `Failed to start Python process:\n\n${error.message}\n\nPython path: ${this.pythonPath}\nServer script: ${this.serverScript}`
        )
      }

      this.eventEmitter.emit("python:server:error", error)
      this.serverProcess = null
      this.isReady = false
      this.stopHealthCheck()
    })
  }

  /**
   * wait for server to be ready with health checks
   */
  async waitForServerReady() {
    return new Promise((resolve, reject) => {
      let attempts = 0
      const maxAttempts = APP_CONFIG.PYTHON_SERVER.MAX_STARTUP_RETRIES * 6 // 6 attempts per retry

      const checkHealth = async () => {
        attempts++

        try {
          const url = this.getServerUrl("/")
          const response = await this.makeHttpRequest(url)

          if (response.statusCode === 200) {
            this.isReady = true
            this.startHealthCheck()
            clearTimeout(this.startupTimeout)
            resolve()
            return
          }
        } catch (error) {
          // server not ready yet
        }

        if (attempts >= maxAttempts) {
          clearTimeout(this.startupTimeout)
          reject(new Error("Server startup timeout - health check failed"))
          return
        }

        // try again after delay
        setTimeout(checkHealth, APP_CONFIG.PYTHON_SERVER.HEALTH_CHECK_INTERVAL)
      }

      // start health checking after a brief delay
      setTimeout(checkHealth, 2000)

      // overall startup timeout
      this.startupTimeout = setTimeout(() => {
        reject(new Error("Server startup timeout"))
      }, APP_CONFIG.PYTHON_SERVER.STARTUP_TIMEOUT)
    })
  }

  /**
   * start periodic health checks
   */
  startHealthCheck() {
    this.stopHealthCheck() // clear any existing interval

    this.healthCheckInterval = setInterval(async () => {
      try {
        const url = this.getServerUrl("/")
        const response = await this.makeHttpRequest(url)

        if (response.statusCode !== 200) {
          throw new Error(`Health check failed: ${response.statusCode}`)
        }

        const healthData = JSON.parse(response.body)

        // check if server is busy with downloads
        // note: we track active downloads but don't use it for health status

        if (!this.isReady) {
          this.isReady = true
          this.eventEmitter.emit("python:server:ready")
        }

      } catch (error) {
        console.warn("health check failed:", error.message)

        // only mark as not ready if it's been failing consistently
        if (this.isReady) {
          this.isReady = false
          this.eventEmitter.emit("python:server:error", error)
        }
      }
    }, APP_CONFIG.PYTHON_SERVER.HEALTH_CHECK_INTERVAL)
  }

  /**
   * stop health checks
   */
  stopHealthCheck() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval)
      this.healthCheckInterval = null
    }
  }

  /**
   * stop the python server
   */
  async stopServer() {

    this.stopHealthCheck()

    if (this.startupTimeout) {
      clearTimeout(this.startupTimeout)
      this.startupTimeout = null
    }

    if (!this.serverProcess) {
      return
    }

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.serverProcess.kill("SIGKILL")
        resolve()
      }, 5000)

      this.serverProcess.once("close", () => {
        clearTimeout(timeout)
        resolve()
      })

      // try graceful shutdown first
      this.serverProcess.kill("SIGTERM")
    })
  }

  /**
   * check if server is ready
   * @returns {boolean} server ready status
   */
  isServerReady() {
    return this.isReady && this.serverProcess !== null
  }

  /**
   * get server url for endpoint
   * @param {string} endpoint - api endpoint
   * @returns {string} full url
   */
  getServerUrl(endpoint = "/") {
    const { HOST, PORT } = APP_CONFIG.PYTHON_SERVER
    return `http://${HOST}:${PORT}${endpoint}`
  }

  /**
   * make http request using node.js http module
   * @param {string} url - request url
   * @returns {Promise<Object>} response object with statusCode and body
   */
  makeHttpRequest(url) {
    return new Promise((resolve, reject) => {
      const request = http.get(url, (response) => {
        let body = ""

        response.on("data", (chunk) => {
          body += chunk
        })

        response.on("end", () => {
          resolve({
            statusCode: response.statusCode,
            body: body
          })
        })
      })

      request.on("error", (error) => {
        reject(error)
      })

      request.setTimeout(10000, () => {
        request.destroy()
        reject(new Error("Request timeout"))
      })
    })
  }

  /**
   * make http request to python server
   * @param {string} endpoint - api endpoint
   * @param {Object} options - request options
   * @returns {Promise<Response>} fetch response
   */
  async makeRequest(endpoint, options = {}) {
    if (!this.isServerReady()) {
      throw new Error("Python server is not ready")
    }

    const url = this.getServerUrl(endpoint)
    const config = {
      timeout: HTTP_CONFIG.TIMEOUT,
      headers: HTTP_CONFIG.HEADERS,
      ...options
    }

    let lastError = null

    // retry logic
    for (let attempt = 1; attempt <= HTTP_CONFIG.RETRIES; attempt++) {
      try {
        const response = await fetch(url, config)

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`)
        }

        return response
      } catch (error) {
        lastError = error
        console.warn(`request attempt ${attempt} failed:`, error.message)

        if (attempt < HTTP_CONFIG.RETRIES) {
          await new Promise((resolve) =>
            setTimeout(resolve, HTTP_CONFIG.RETRY_DELAY * attempt)
          )
        }
      }
    }

    throw lastError
  }

  /**
   * ensure python dependencies are installed (for cross-platform builds)
   */
  async ensureDependencies() {
    if (this.isDevelopment) {
      // skip in development - use venv
      return
    }

    try {
      
      // check if yt-dlp is available
      const { spawn } = require("child_process")
      
      const checkResult = await new Promise((resolve) => {
        const checkProcess = spawn(this.pythonPath, ["-c", "import yt_dlp; print('OK')"], {
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            ...process.env,
            PYTHONUNBUFFERED: "1"
          }
        })

        checkProcess.on("close", (code) => {
          resolve(code === 0)
        })

        checkProcess.on("error", (error) => {
          console.warn("python dependency check error:", error.message)
          resolve(false)
        })
      })

      if (checkResult) {
        return
      }

      // dependencies missing - try to install them
      
      // simple path: requirements.txt is in the same directory as python.exe
      const runtimeDir = path.dirname(this.pythonPath)
      const requirementsPath = path.join(runtimeDir, "requirements.txt")
      
      
      // check if requirements.txt exists
      const fs = require("fs").promises
      try {
        await fs.access(requirementsPath)
      } catch {
        return
      }

      // install dependencies with proper environment
      await new Promise((resolve) => {
        
        const args = [
          "-m", "pip", "install", 
          "--user",                    // install to user directory
          "--no-cache-dir",           // don't use cache
          "--no-warn-script-location", // suppress warnings
          "--disable-pip-version-check", // suppress pip version warnings
          "-r", requirementsPath
        ]
        
        
        const installProcess = spawn(this.pythonPath, args, {
          stdio: ["pipe", "pipe", "pipe"],
          cwd: runtimeDir,
          env: {
            ...process.env,
            PYTHONUNBUFFERED: "1"
          }
        })

        let stdout = ""
        let stderr = ""
        
        installProcess.stdout.on("data", (data) => {
          const output = data.toString()
          stdout += output
        })
        
        installProcess.stderr.on("data", (data) => {
          stderr += data.toString()
        })

        installProcess.on("close", (code) => {
          if (code !== 0) {
            console.warn("dependency installation failed, but continuing...")
            console.warn("   exit code:", code)
            console.warn("   error output:", stderr)
            console.warn("   standard output:", stdout)
          }
          resolve() // don't fail startup for dependency issues
        })

        installProcess.on("error", (error) => {
          console.warn("dependency installation process error:", error.message)
          resolve() // don't fail startup
        })
      })

    } catch (error) {
      console.warn("dependency check failed:", error.message)
      // don't fail startup for dependency issues
    }
  }


  /**
   * get server status information
   * @returns {Object} server status
   */
  getStatus() {
    return {
      isReady: this.isReady,
      hasProcess: this.serverProcess !== null,
      serverUrl: this.getServerUrl(),
      pythonPath: this.pythonPath,
      serverScript: this.serverScript,
      isDevelopment: this.isDevelopment
    }
  }
}

module.exports = ServerManager
