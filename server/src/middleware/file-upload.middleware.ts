// server/src/middleware/file-upload.middleware.ts
// multer 文件上传（知识库文档上传用）
// memoryStorage：文件先存内存，再由业务代码决定怎么处理
// diskStorage：直接存磁盘（大文件推荐）
import multer from 'multer'
import path from 'path'
import type { NextFunction, Request, Response } from 'express'
import { BadRequestException } from '@nestjs/common'
import { decodeOriginalName } from '../utils/filename.js'

// multer 1.4.5-lts.1+ 运行时支持 defParamCharset（透传给 busboy），@types/multer 1.4.x 未声明该选项
declare module 'multer' {
  interface Options {
    defParamCharset?: 'latin1' | 'utf8'
  }
}

// busboy 按 UTF-8 解析 multipart filename（默认 latin1 会让中文文件名变乱码）；
// decodeOriginalName 再兜底修复异常客户端
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, './uploads/'),
  filename: (req, file, cb) => {
    // 磁盘文件名只用 ASCII（时间戳+随机），避免 Windows 编码问题；展示名在业务层解码后入库
    const ext = path.extname(decodeOriginalName(file.originalname))
    const name = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}${ext}`
    cb(null, name)
  },
})

const upload = multer({
  storage,
  defParamCharset: 'utf8',
  limits: {
    fileSize: 30 * 1024 * 1024,  // 最大 30MB
  },
  fileFilter: (req, file, cb) => {
    // 知识库允许：纯文本 / Markdown / PDF / Word（docx 走 mammoth 抽取，与合同同一套解析）
    const allowed = ['.txt', '.md', '.pdf', '.docx']
    const ext = path.extname(decodeOriginalName(file.originalname)).toLowerCase()
    if (allowed.includes(ext)) {
      cb(null, true)
    } else {
      cb(new Error(`不支持的文件格式 ${ext}，只支持 ${allowed.join(', ')}`))
    }
  },
})

const singleFile = upload.single('file')

export function fileUpload(req: Request, res: Response, next: NextFunction) {
  singleFile(req, res, (err?: any) => {
    if (err) return next(err)
    // 统一解码中文文件名（defParamCharset=utf8 已处理主流浏览器，这里再兜底一次）
    if ((req as any).file) {
      (req as any).file.originalname = decodeOriginalName((req as any).file.originalname)
    }
    next()
  })
}

// 合同上传：在知识库允许的格式外追加 .docx（合同最常见格式）
// 以及 .jpg/.jpeg/.png：纸质/扫描合同拍照后走 deepseek-flash 视觉 OCR
const contractMulter = multer({
  storage,
  defParamCharset: 'utf8',
  // 硬上限取付费套餐最大值 15MB；免费档的 8MB 限制在 Controller 按套餐二次校验
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.txt', '.md', '.pdf', '.docx', '.jpg', '.jpeg', '.png']
    const ext = path.extname(decodeOriginalName(file.originalname)).toLowerCase()
    if (allowed.includes(ext)) {
      cb(null, true)
    } else {
      cb(new BadRequestException(`不支持的文件格式 ${ext}，只支持 ${allowed.join(', ')}`))
    }
  },
}).single('file')

export function contractFileUpload(req: Request, res: Response, next: NextFunction) {
  contractMulter(req, res, (err?: any) => {
    if (err) {
      // multer 在传输层截断的超限错误（文件 > 15MB 硬上限）转成中文 400
      if (err?.code === 'LIMIT_FILE_SIZE') {
        return next(new BadRequestException('文件过大，单文件不能超过 15MB'))
      }
      return next(err)
    }
    // 统一解码中文文件名（defParamCharset=utf8 已处理主流浏览器，这里再兜底一次）
    if ((req as any).file) {
      (req as any).file.originalname = decodeOriginalName((req as any).file.originalname)
    }
    next()
  })
}
