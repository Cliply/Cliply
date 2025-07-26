// file helper functions

const fs = require("fs").promises
const path = require("path")

class FileUtils {
  // clean filename for all operating systems
  static sanitizeFilename(filename) {
    if (!filename) return "untitled"

    // remove unsafe characters
    let sanitized = filename
      // remove path separators and other unsafe characters
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
      // replace multiple spaces with single space
      .replace(/\s+/g, " ")
      // trim whitespace
      .trim()

    // handle empty result
    if (!sanitized) {
      sanitized = "untitled"
    }

    // limit length (keep reasonable filename length)
    if (sanitized.length > 200) {
      sanitized = sanitized.substring(0, 200).trim()
    }

    // remove trailing dots (windows issue)
    sanitized = sanitized.replace(/\.+$/, "")

    // handle reserved names on windows
    const reservedNames = [
      "CON", "PRN", "AUX", "NUL",
      "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
      "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"
    ]
    if (reservedNames.includes(sanitized.toUpperCase())) {
      sanitized = `_${sanitized}`
    }

    return sanitized
  }

  // format file size in human readable format
  static formatFileSize(bytes) {
    if (!bytes || bytes === 0) return "0 B"

    const sizes = ["B", "KB", "MB", "GB", "TB"]
    const i = Math.floor(Math.log(bytes) / Math.log(1024))
    const size = (bytes / Math.pow(1024, i)).toFixed(2)

    return `${size} ${sizes[i]}`
  }

  // check if file exists
  static async exists(filePath) {
    try {
      await fs.access(filePath)
      return true
    } catch {
      return false
    }
  }

  // get file size
  static async getFileSize(filePath) {
    try {
      const stats = await fs.stat(filePath)
      return stats.size
    } catch {
      return 0
    }
  }

  // get file extension from filename
  static getExtension(filename) {
    if (!filename) return ""
    const ext = path.extname(filename)
    return ext.startsWith(".") ? ext.slice(1) : ext
  }

  // generate unique filename to avoid conflicts
  static async generateUniqueFilename(basePath, filename) {
    const ext = path.extname(filename)
    const name = path.basename(filename, ext)
    let counter = 1
    let uniqueFilename = filename

    while (await this.exists(path.join(basePath, uniqueFilename))) {
      uniqueFilename = `${name} (${counter})${ext}`
      counter++
    }

    return uniqueFilename
  }

  // create directory recursively if it doesn't exist
  static async ensureDirectory(dirPath) {
    try {
      await fs.mkdir(dirPath, { recursive: true })
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error
      }
    }
  }

  // delete file safely
  static async deleteFile(filePath) {
    try {
      await fs.unlink(filePath)
      return true
    } catch (error) {
      console.error(`Failed to delete file ${filePath}:`, error.message)
      return false
    }
  }

  // copy file
  static async copyFile(source, destination) {
    try {
      await fs.copyFile(source, destination)
      return true
    } catch (error) {
      console.error(
        `Failed to copy file from ${source} to ${destination}:`,
        error.message
      )
      return false
    }
  }

  // move/rename file
  static async moveFile(source, destination) {
    try {
      await fs.rename(source, destination)
      return true
    } catch (error) {
      console.error(
        `Failed to move file from ${source} to ${destination}:`,
        error.message
      )
      return false
    }
  }

  // read text file
  static async readTextFile(filePath, encoding = "utf8") {
    try {
      return await fs.readFile(filePath, encoding)
    } catch (error) {
      console.error(`Failed to read file ${filePath}:`, error.message)
      throw error
    }
  }

  // write text file
  static async writeTextFile(filePath, content, encoding = "utf8") {
    try {
      await fs.writeFile(filePath, content, encoding)
      return true
    } catch (error) {
      console.error(`Failed to write file ${filePath}:`, error.message)
      return false
    }
  }

  // list files in directory
  static async listFiles(dirPath, options = {}) {
    const { extensions = [], recursive = false } = options

    try {
      const files = []
      const items = await fs.readdir(dirPath, { withFileTypes: true })

      for (const item of items) {
        const fullPath = path.join(dirPath, item.name)

        if (item.isFile()) {
          // check extension filter
          if (
            extensions.length === 0 ||
            extensions.includes(this.getExtension(item.name))
          ) {
            files.push(fullPath)
          }
        } else if (item.isDirectory() && recursive) {
          // recursively list subdirectory
          const subFiles = await this.listFiles(fullPath, options)
          files.push(...subFiles)
        }
      }

      return files
    } catch (error) {
      console.error(`Failed to list files in ${dirPath}:`, error.message)
      return []
    }
  }

  // get file info
  static async getFileInfo(filePath) {
    try {
      const stats = await fs.stat(filePath)
      return {
        exists: true,
        size: stats.size,
        sizeFormatted: this.formatFileSize(stats.size),
        created: stats.birthtime,
        modified: stats.mtime,
        isFile: stats.isFile(),
        isDirectory: stats.isDirectory(),
        extension: this.getExtension(filePath),
        basename: path.basename(filePath),
        dirname: path.dirname(filePath)
      }
    } catch (error) {
      return {
        exists: false,
        error: error.message
      }
    }
  }

  // clean up old files in directory
  static async cleanupOldFiles(dirPath, maxAge) {
    try {
      const files = await this.listFiles(dirPath)
      const now = Date.now()
      let deletedCount = 0

      for (const filePath of files) {
        const stats = await fs.stat(filePath)
        const age = now - stats.mtime.getTime()

        if (age > maxAge) {
          if (await this.deleteFile(filePath)) {
            deletedCount++
          }
        }
      }

      return deletedCount
    } catch (error) {
      console.error(`Failed to cleanup old files in ${dirPath}:`, error.message)
      return 0
    }
  }

  // validate file path is safe (no directory traversal)
  static isPathSafe(filePath, basePath) {
    const resolvedPath = path.resolve(filePath)
    const resolvedBase = path.resolve(basePath)

    return resolvedPath.startsWith(resolvedBase)
  }
}

module.exports = FileUtils