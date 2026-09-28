// server/src/types/js-modules.d.ts
// 保留的 JS 业务模块（services/config/utils）类型声明
// 这些文件不参与 TS 类型检查（LangChain 类型图过大），构建时由 esbuild 转译为 CJS

declare module '*/services/*' {
  export const chatModel: any
  export function createChatModel(options?: any): any

  export const cache: any

  export function getHistory(sessionId: string): any[]
  export function trimHistory(history: any[], maxTokens: number): any[]
  export function clearHistory(sessionId: string): void
  export function listSessions(): any[]

  export function getVectorStore(): Promise<any>
  export function getDocRegistry(): any[]
  export function getDoc(docId: string): any
  export function loadDocRegistryFromChroma(): Promise<any>
  export function ingestDocument(meta: any): Promise<any>
  export function deleteDocument(docId: string): Promise<any>

  export function retrieveDocs(question: string, options?: any): Promise<any>
  export function ragQuery(question: string, options?: any): Promise<any>
  export function ragQueryStream(question: string, options?: any): Promise<any>

  export function getSession(sessionId: string): any
  export function addMessage(sessionId: string, role: string, content: string): void
  export function getFormattedHistory(sessionId: string, maxRounds?: number): string
  export function getMessageHistory(sessionId: string, maxRounds?: number): any[]
  export function clearSession(sessionId: string): void
  export function cleanupExpiredSessions(): void
  export function rewriteQuery(question: string, sessionId: string): Promise<any>

  export function runAgent(task: string, onEvent?: (type: string, data: any) => void): Promise<any>
  export function getToolList(): any[]

  export function parseExpenseForm(text: string): Promise<any>
  export function parseLeaveForm(text: string): Promise<any>
  export function checkCompliance(form: any): any[]
  export function runApprovalFlow(formData: any, formType: string, onEvent?: (type: string, data: any) => void): Promise<any>
  export const APPROVAL_ROLES: Record<string, any>

  export const WORKFLOW_BUILDERS: Record<string, () => any>
  export const WORKFLOW_META: Record<string, any>

  export function listTemplates(): any[]
  export function getTemplate(id: string): any
  export function saveTemplate(data: any): any
  export function deleteTemplate(id: string): void
  export function scoreAbTest(data: any): Promise<any>
}

declare module '*/config/*' {
  export const config: any
  export function validateConfig(): void
}

declare module '*/utils/*' {
  export class AppError extends Error {
    code: string
    statusCode: number
    retryable: boolean
    userMessage: string
    constructor(message: string, options?: any)
  }
  export function classifyError(err: any): AppError
  export function initSse(res: any): { send: (event: string, data?: any) => void; error: (err: any) => void; end: () => void }
  export const logger: any
}
