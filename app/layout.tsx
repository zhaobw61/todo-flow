import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "TodoFlow｜今天，想完成什么？",
  description: "一个简洁、好用并能自动保存的中文 TodoList。",
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
  openGraph: {
    title: "TodoFlow｜今天，想完成什么？",
    description: "把任务写下来，一件一件完成。",
  },
  twitter: {
    card: "summary",
    title: "TodoFlow｜今天，想完成什么？",
    description: "把任务写下来，一件一件完成。",
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        {children}
      </body>
    </html>
  );
}
