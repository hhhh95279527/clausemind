// server/src/utils/file-guard.ts
// 上传文件真实类型校验：扩展名可伪造，multer fileFilter 只拿到文件名，
// 因此落盘后、交给解析器前，按文件头 magic number 再验一次，防改后缀上传可执行/脚本内容。
import fs from 'fs/promises'
import { BadRequestException } from '@nestjs/common'

const HEAD_BYTES = 4096

/** ZIP 容器（docx/xlsx/zip…）：50 4B 03 04 / 05 06（空包）/ 07 08（跨卷） */
function isZip(buf: Buffer): boolean {
  return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b
    && (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07)
}

/**
 * 校验磁盘文件真实类型与声称扩展名一致；不一致抛 400。
 * 调用方负责在失败时删除已落盘的临时文件。
 */
export async function assertRealFileType(filePath: string, ext: string): Promise<void> {
  let head: Buffer
  try {
    const fh = await fs.open(filePath, 'r')
    try {
      const buf = Buffer.alloc(HEAD_BYTES)
      const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0)
      head = buf.subarray(0, bytesRead)
    } finally {
      await fh.close()
    }
  } catch {
    throw new BadRequestException('上传文件无法读取')
  }

  if (head.length === 0) {
    throw new BadRequestException('上传文件为空')
  }

  const e = ext.toLowerCase()
  if (e === '.pdf') {
    // PDF：%PDF-
    if (head.subarray(0, 5).toString('latin1') !== '%PDF-') {
      throw new BadRequestException('文件内容不是有效的 PDF（magic number 校验失败）')
    }
    return
  }

  if (e === '.docx') {
    // docx = OOXML zip 容器
    if (!isZip(head)) {
      throw new BadRequestException('文件内容不是有效的 Word 文档（应为 ZIP/OOXML 容器）')
    }
    return
  }

  if (e === '.jpg' || e === '.jpeg') {
    // JPEG：FF D8 FF
    if (!(head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff)) {
      throw new BadRequestException('文件内容不是有效的 JPEG 图片（magic number 校验失败）')
    }
    return
  }

  if (e === '.png') {
    // PNG：89 50 4E 47 0D 0A 1A 0A
    const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
    const ok = PNG_SIG.every((b, i) => head[i] === b)
    if (!ok) {
      throw new BadRequestException('文件内容不是有效的 PNG 图片（magic number 校验失败）')
    }
    return
  }

  if (e === '.txt' || e === '.md') {
    // 文本类：出现 NUL 字节基本可判定为二进制伪装；UTF-16 文本以 BOM 或 0x00 交替出现，
    // 对含 BOM 的 UTF-16 放行，交由后续解析处理。
    const hasBom = (head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff)
    if (!hasBom && head.includes(0x00)) {
      throw new BadRequestException('文本文件包含二进制内容，疑似伪造扩展名')
    }
    return
  }

  throw new BadRequestException(`不支持的文件类型 ${e}`)
}
