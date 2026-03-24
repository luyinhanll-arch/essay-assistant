import type { Metadata } from 'next'
import { Inter, Lora } from 'next/font/google'
import './globals.css'

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
})

const lora = Lora({
  subsets: ['latin'],
  variable: '--font-lora',
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'EssayMind · AI留学文书助手',
  description: '它看得到学校没说出口的偏好，它听得出你平庸文字背后的真实闪光点',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" className={`${inter.variable} ${lora.variable}`}>
      <body className="min-h-screen bg-[#1C1917] text-white antialiased">
        {children}
      </body>
    </html>
  )
}
