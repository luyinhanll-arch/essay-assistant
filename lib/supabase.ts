/** 获取或创建匿名用户 token（存在 localStorage），仅客户端调用 */
export function getUserToken(): string {
  if (typeof window === 'undefined') return ''
  let token = localStorage.getItem('essay-user-token')
  if (!token) {
    token = crypto.randomUUID()
    localStorage.setItem('essay-user-token', token)
  }
  return token
}

export interface Essay {
  id: string
  user_token: string
  school: string
  program: string | null
  degree: string | null
  essay_type: string
  en_text: string | null
  zh_text: string | null
  updated_at: string
}
