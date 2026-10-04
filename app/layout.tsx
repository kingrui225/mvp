import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Instagram Search',
  description: 'Search Instagram posts, reels, and more.',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en">
      <body className="antialiased">
        {children}
      </body>
    </html>
  )
}
