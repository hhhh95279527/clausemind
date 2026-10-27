// 历史文档向量回填：为 embedding 为空的切片补生成向量。
// 适用场景：先以关键词模式入库（未配置 embedding key），之后配置了 key，需补齐旧切片。
// 运行：npm run backfill:embeddings
import { PrismaClient } from '@prisma/client'
import { embedTexts } from '../src/services/rag/pg-store.js'
import { config } from '../src/config/index.js'

const prisma = new PrismaClient()
const BATCH = 32

async function main() {
  if (!config.ai.zhipuKey && !config.ai.openaiKey) {
    console.error('未配置 ZHIPU_API_KEY / OPENAI_API_KEY，无法生成向量')
    process.exit(1)
  }

  const all = await prisma.docChunk.findMany({
    select: { id: true, content: true, embedding: true },
  })
  const empty = all.filter((c) => {
    const vec = c.embedding as unknown as number[] | null
    return !Array.isArray(vec) || vec.length === 0
  })
  console.log(`切片总数 ${all.length}，待回填 ${empty.length}`)
  if (!empty.length) return

  let done = 0
  for (let i = 0; i < empty.length; i += BATCH) {
    const batch = empty.slice(i, i + BATCH)
    const vecs = await embedTexts(batch.map((c) => c.content))
    if (vecs.length !== batch.length) throw new Error(`向量数量不匹配：期望 ${batch.length}，实际 ${vecs.length}`)
    await prisma.$transaction(
      batch.map((c, j) =>
        prisma.docChunk.update({ where: { id: c.id }, data: { embedding: vecs[j] as any } }),
      ),
    )
    done += batch.length
    console.log(`已回填 ${done}/${empty.length}`)
  }
  console.log('回填完成')
}

main()
  .catch((e) => {
    console.error('回填失败:', e.message)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
