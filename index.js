import crypto from 'crypto'
import fastify from 'fastify' 
import fastifyCors from 'fastify-cors'
import fastifyMultipart from 'fastify-multipart'
import fastifyStatic from 'fastify-static'
import FileType from 'file-type'
import fs from 'fs'
import { rename } from 'fs/promises'
import path from 'path'
import { Storage } from '@google-cloud/storage'


function checksum (str, options=null) {
  const {
    algorithm='md5', encoding='hex', length=8, lengthFromEnd=null, useFullHash=false
  } = options || {}
  const fullHash = crypto.createHash(algorithm).update(str).digest(encoding)
  let shortHash = ''

  if (lengthFromEnd) shortHash = fullHash.substr(-lengthFromEnd)
  else if (length) shortHash = fullHash.substr(0, length)

  return (useFullHash || !shortHash) ? fullHash : shortHash
}

function hashFilename (filePath, originalName, options=null) {
  const { addRandomString=true, separator='.', useFullHash=false } = options || {}
  const fileBodyHash = checksum(fs.readFileSync(filePath), { useFullHash })
  const filenameHash = checksum(originalName, { lengthFromEnd: 5 })
  let randomNum = ''

  if (addRandomString) {
    randomNum = String(Date.now()).substr(-3)
  }

  return `${filenameHash}${randomNum}${separator}${fileBodyHash}`
}

async function saveFileToLocal (fileObject, destPath, options=null) {
  const { fileDir='', prefix='', renameFile=true } = options || {}
  const { buffer, file, fieldname, filename: originalName, ext, encoding, mimetype } = fileObject
  let filename = prefix + originalName
  const destFile = path.join(destPath, filename)

  await writeStream(buffer, destFile)

  if (renameFile) {
    const options = typeof renameFile === 'object' ? renameFile : null
    const hashStr = hashFilename(destFile, originalName, options)

    filename = `${prefix}${hashStr}.${ext}`
    await rename(destFile, path.join(destPath, filename))
  }

  const url =  (fileDir) ? `${SERVER_DOMAIN}/${fileDir}/${filename}` : `${SERVER_DOMAIN}/${filename}`

  return {
    encoding, fieldname, filename, ext, mimetype, originalName, url
  }
}

async function saveFileToGoogleStorage (fileObject, destPath, options=null) {
  const { prefix='', renameFile=true } = options || {}
  const { buffer, file, fieldname, filename: originalName, ext, encoding, mimetype } = fileObject
  let filename = prefix + originalName
  const tmpFile = path.join('upload', filename)

  await writeStream(buffer, tmpFile)

  if (renameFile) {
    const options = typeof renameFile === 'object' ? renameFile : null
    const hashStr = hashFilename(tmpFile, originalName, options)

    filename = `${prefix}${hashStr}.${ext}`
  }

  try {
    const storage     = new Storage()
    const bucket      = storage.bucket(BUCKET_NAME)
    const destination = (destPath) ? `${destPath}/${filename}` : filename

    const file     = bucket.file(destination)
    const [exists] = await file.exists()

    if (exists) return 0

    const gzip = true
    const metadata = {
      cacheControl: 'public, max-age=31536000',
      contentLanguage: 'en',
      metadata: {
        fieldname,
        encoding,
        mimetype,
        name: filename,
        originalName
      }
    }
    const [result] = await bucket.upload(tmpFile, { destination, gzip, metadata, public: true })

    fs.unlinkSync(tmpFile)

    const apiEndpoint = result?.storage?.apiEndpoint
    const url         = `${apiEndpoint}/${BUCKET_NAME}/${filename}`

    return {
      apiEndpoint, encoding, fieldname, filename, ext, mimetype, originalName, url
    }
  } catch (e) {
    return JSON.parse(e.response.body)
  }
}

async function validateFileType (file, matchType='image') {
  const buffer = await file.toBuffer()
  const { ext, mime: mimetype } = await FileType.fromBuffer(buffer)

  if (mimetype.indexOf(matchType + '/') === -1) {
    return {
      error: {
        code: 'FST_REQ_INVALID_FILE_TYPE',
        error: 'Unsupported Media Type',
        message: `Server accepts only ${matchType} type`,
        statusCode: 415
      },
      result: null
    }
  }

  const result = { buffer, ext, mimetype }

  return { error: null, result }
}

function writeStream (buffer, dest) {
  return new Promise((resolve, reject) => {
    const writeStream = fs.createWriteStream(dest)

    writeStream.on('error', err => {
      reject(err)
    })

    writeStream.write(buffer, resolve)
    writeStream.end()
  })
}

const app       = fastify()
const publicDir = 'public'
const {
  BUCKET_NAME='', IMAGE_DIR='images', MAX_FILE_SIZE=1_000_000, MAX_FILES=1,
  SERVER_DOMAIN='', SERVER_HOST='0.0.0.0', SERVER_PORT=3000, UPLOAD_TO_GCS=false
} = process.env || {}
const fileSize = parseInt(MAX_FILE_SIZE)
const files    = parseInt(MAX_FILES)

app.register(fastifyCors, {
  origin: (origin, cb) => {
    if (
      /kokweng.net/.test(origin) ||
      /localhost/.test(origin)
    ) {
      cb(null, true)
      return
    }

    cb(new Error('Not allowed'))
  },
  credentials: true
})
app.register(fastifyMultipart, {
  attachFieldsToBody: true,
  limits: {
    fieldNameSize: 100, // Max field name size in bytes
    fieldSize: 100,     // Max field value size in bytes
    fields: 10,         // Max number of non-file fields
    fileSize,           // For multipart forms, the max file size in bytes
    files,              // Max number of file fields
    headerPairs: 2000   // Max number of header key=>value pairs
  }
})
app.register(fastifyStatic, {
  root: path.resolve(`./${publicDir}`),
  list: true
})


app.post('/upload/image', async (req, reply) => {
  try {
    const promises = []
    const entries  = Object.entries(req.body)

    for (let [_, val] of entries) {
      if (val.file) {
        const { error, result } = await validateFileType(val)

        if (error) {
          reply.code(error.statusCode).send(error)
          return
        }

        const prefix = 'img.'

        if (UPLOAD_TO_GCS) {
          promises.push(
            saveFileToGoogleStorage({ ...val, ...result }, null, { prefix })
          )
        } else {
          promises.push(
            saveFileToLocal({ ...val, ...result }, path.join(publicDir, IMAGE_DIR), { fileDir: IMAGE_DIR, prefix })
          )
        }
      } else {
        const { fieldname, fieldnameTruncated, value, valueTruncated } = val
        // console.log({ fieldname, fieldnameTruncated, value, valueTruncated })
      }
    }

    const [result] = await Promise.all(promises)

    if (result && result.error && result.error.code) {
      reply.code(result.error.code).send(result.error)
      return
    }

    reply.send(result)
  } catch (err) {
    reply.send(err)
  }
})


app.listen(SERVER_PORT, SERVER_HOST, err => {
  if (err) throw err

  const { address, port } = app.server.address()

  console.log(`server listening on ${address}:${port}`)
})
