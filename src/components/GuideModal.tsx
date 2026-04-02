"use client";

import { useState } from "react";

const TABS = [
  { id: "usage", label: "การใช้งาน" },
  { id: "install", label: "การติดตั้ง" },
  { id: "api", label: "API Reference" },
  { id: "troubleshoot", label: "แก้ไขปัญหา" },
] as const;

type TabId = (typeof TABS)[number]["id"];

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="text-lg font-bold text-white mb-3 flex items-center gap-2">{children}</h3>;
}

function SubTitle({ children }: { children: React.ReactNode }) {
  return <h4 className="text-sm font-bold text-indigo-300 mt-5 mb-2">{children}</h4>;
}

function Code({ children }: { children: string }) {
  return (
    <pre className="bg-black/40 border border-white/10 rounded-lg p-3 text-xs text-gray-300 overflow-x-auto font-mono my-2">
      {children}
    </pre>
  );
}

function Paragraph({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-gray-400 leading-relaxed mb-3">{children}</p>;
}

function Warning({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 mb-4">
      <div className="flex items-start gap-2">
        <span className="text-amber-400 shrink-0">&#9888;</span>
        <div className="text-sm text-amber-300">{children}</div>
      </div>
    </div>
  );
}

function TableRow({ label, value }: { label: string; value: string }) {
  return (
    <tr className="border-b border-white/5">
      <td className="py-2 pr-4 text-sm font-mono text-indigo-300 whitespace-nowrap">{label}</td>
      <td className="py-2 text-sm text-gray-400">{value}</td>
    </tr>
  );
}

// ─── Tab: การใช้งาน ──────────────────────────────────────────────────────────

function UsageGuide() {
  return (
    <div className="space-y-6">
      <Warning>
        <strong>ระบบนี้ไม่มี API Key Authentication</strong> — ห้ามเปิดให้ภายนอกเข้าถึง
        <br />แนะนำให้ติดตั้งบน Local หรือ Network ภายในองค์กรเท่านั้น
        <br />หากต้องการเปิดให้ภายนอกใช้งาน ให้นำ Code ไปแก้ไขเพิ่มระบบ Authentication ก่อน
      </Warning>

      <div>
        <SectionTitle>ภาพรวมระบบ</SectionTitle>
        <Paragraph>
          BCProxyAI เป็น Smart AI Gateway ที่สแกนหาโมเดล AI ฟรีจาก 4 ผู้ให้บริการ
          (OpenRouter, Kilo AI, Google AI Studio, Groq) แล้วเลือกตัวที่ดีที่สุดให้อัตโนมัติ
          ใช้งานผ่าน API ที่เข้ากันได้กับ OpenAI 100%
        </Paragraph>
      </div>

      <div>
        <SectionTitle>เชื่อมต่อกับ OpenClaw / HiClaw</SectionTitle>
        <Paragraph>เปิด Settings ของ OpenClaw แล้วตั้งค่าดังนี้:</Paragraph>
        <Code>{`{
  "apiProvider": "openai-compatible",
  "openAiBaseUrl": "http://localhost:3333/v1",
  "openAiModelId": "auto"
}`}</Code>
        <Paragraph>
          <span className="text-indigo-300">auto</span> = ให้ BCProxyAI เลือกโมเดลที่ดีที่สุดให้อัตโนมัติ
        </Paragraph>
      </div>

      <div>
        <SectionTitle>Virtual Models (โมเดลพิเศษ)</SectionTitle>
        <Paragraph>BCProxyAI มีโมเดลพิเศษ 4 ตัวที่เลือกให้อัตโนมัติ:</Paragraph>
        <table className="w-full">
          <tbody>
            <TableRow label="auto" value="เลือกโมเดลที่คะแนน benchmark สูงสุด" />
            <TableRow label="bcproxy/fast" value="เลือกโมเดลที่ตอบเร็วที่สุด (latency ต่ำสุด)" />
            <TableRow label="bcproxy/tools" value="เลือกโมเดลที่รองรับ tool calling" />
            <TableRow label="bcproxy/thai" value="เลือกโมเดลที่เก่งภาษาไทย (คะแนนสูงสุด)" />
          </tbody>
        </table>
      </div>

      <div>
        <SectionTitle>การตรวจจับอัตโนมัติ</SectionTitle>
        <Paragraph>
          แม้จะใช้ <span className="text-indigo-300">auto</span> แต่ถ้า request มีลักษณะพิเศษ ระบบจะตรวจจับและเลือกให้เหมาะ:
        </Paragraph>
        <ul className="list-disc list-inside text-sm text-gray-400 space-y-1 ml-2">
          <li>มี <code className="text-indigo-300">tools</code> ใน request &rarr; เลือกเฉพาะโมเดลที่รองรับ tool calling</li>
          <li>มี <code className="text-indigo-300">image_url</code> ใน messages &rarr; เลือกเฉพาะโมเดลที่รองรับ vision</li>
          <li>มี <code className="text-indigo-300">response_format: json_schema</code> &rarr; เลือกโมเดลขนาดใหญ่</li>
        </ul>
      </div>

      <div>
        <SectionTitle>การใช้โมเดลตรง</SectionTitle>
        <Paragraph>ระบุ provider + model ID ตรงๆ ได้เลย:</Paragraph>
        <Code>{`groq/llama-3.3-70b-versatile
openrouter/qwen/qwen3-coder:free
kilo/nvidia/nemotron-3-super-120b-a12b:free`}</Code>
      </div>

      <div>
        <SectionTitle>Auto-Fallback</SectionTitle>
        <Paragraph>
          ถ้าโมเดลที่เลือกตอบ error (429 rate limit หรือ 5xx) ระบบจะสลับไปใช้โมเดลอื่นอัตโนมัติ
          สูงสุด 3 ครั้ง โดยโมเดลที่ error จะถูกพัก cooldown 2 ชม.
        </Paragraph>
      </div>

      <div>
        <SectionTitle>Worker อัตโนมัติ</SectionTitle>
        <Paragraph>Worker ทำงาน 3 ขั้นตอน ทุก 1 ชั่วโมง:</Paragraph>
        <ul className="list-decimal list-inside text-sm text-gray-400 space-y-2 ml-2">
          <li><span className="text-blue-300 font-medium">Scan</span> — สแกนโมเดลฟรีจาก 4 ผู้ให้บริการ ตรวจจับโมเดลใหม่/หายไป</li>
          <li><span className="text-emerald-300 font-medium">Health Check</span> — ส่ง ping ทดสอบ พักโมเดลที่ติด limit 2 ชม. ทดสอบ tool/vision support</li>
          <li><span className="text-indigo-300 font-medium">Benchmark</span> — สอบ 3 คำถามภาษาไทย ให้คะแนน 0-10 ข้ามโมเดลที่สอบตก 7 วัน</li>
        </ul>
      </div>

      <div>
        <SectionTitle>Dashboard</SectionTitle>
        <Paragraph>หน้านี้แหละ! รีเฟรชอัตโนมัติทุก 15 วินาที แสดง:</Paragraph>
        <ul className="list-disc list-inside text-sm text-gray-400 space-y-1 ml-2">
          <li>สถานะ Worker + นับถอยหลังรอบถัดไป</li>
          <li>สถิติโมเดลทั้งหมด / พร้อมใช้ / พักผ่อน / มีคะแนน</li>
          <li>แจ้งเตือนโมเดลใหม่ / หายชั่วคราว / หายถาวร</li>
          <li>อันดับโมเดลตามคะแนน Benchmark</li>
          <li>ทดลองแชทกับโมเดลได้ทันที</li>
          <li>บันทึกการทำงานของ Worker</li>
        </ul>
      </div>
    </div>
  );
}

// ─── Tab: การติดตั้ง ─────────────────────────────────────────────────────────

function InstallGuide() {
  return (
    <div className="space-y-6">
      <Warning>
        <strong>ติดตั้งบน Local หรือ Network ภายในองค์กรเท่านั้น</strong>
        <br />ระบบนี้ไม่มี API Key Authentication — ห้ามเปิดให้ภายนอก (Internet) เข้าถึง
      </Warning>

      <div>
        <SectionTitle>วิธีที่ 1: Docker (แนะนำ)</SectionTitle>

        <SubTitle>1. Clone โปรเจค</SubTitle>
        <Code>{`git clone https://github.com/jaturapornchai/bcproxyai.git
cd bcproxyai`}</Code>

        <SubTitle>2. สร้างไฟล์ .env.local</SubTitle>
        <Code>{`cp .env.example .env.local`}</Code>
        <Paragraph>แก้ไข <code className="text-indigo-300">.env.local</code> ใส่ API Key:</Paragraph>
        <Code>{`# จำเป็น — สมัครฟรีที่ https://openrouter.ai/keys
OPENROUTER_API_KEY=sk-or-v1-xxxx

# จำเป็น — สมัครฟรีที่ https://console.groq.com/keys
GROQ_API_KEY=gsk_xxxx

# ไม่บังคับ
KILO_API_KEY=
GOOGLE_AI_API_KEY=`}</Code>

        <SubTitle>3. Build และ Start</SubTitle>
        <Code>{`docker compose build
docker compose up -d`}</Code>

        <SubTitle>4. เปิด Dashboard</SubTitle>
        <Paragraph>
          เปิดเบราว์เซอร์ไปที่ <code className="text-indigo-300">http://localhost:3333</code>
        </Paragraph>
        <Paragraph>
          Worker จะเริ่มสแกนโมเดลอัตโนมัติทันที หรือกดปุ่ม &quot;รันตอนนี้&quot; บน Dashboard
        </Paragraph>
      </div>

      <div>
        <SectionTitle>วิธีที่ 2: Manual (ไม่ใช้ Docker)</SectionTitle>
        <Paragraph>ต้องการ Node.js 20+</Paragraph>
        <Code>{`# ติดตั้ง dependencies
npm ci

# สร้างไฟล์ .env.local (ใส่ API Key เหมือนข้างบน)

# Build
npm run build

# Start
npm start`}</Code>
        <Paragraph>
          เข้าใช้งานที่ <code className="text-indigo-300">http://localhost:3000</code>
        </Paragraph>
      </div>

      <div>
        <SectionTitle>วิธีสมัคร API Key (ฟรี)</SectionTitle>
        <table className="w-full">
          <tbody>
            <TableRow label="OpenRouter" value="https://openrouter.ai/keys — สมัครฟรี มีโมเดลฟรีมากที่สุด" />
            <TableRow label="Groq" value="https://console.groq.com/keys — สมัครฟรี เร็วมาก" />
            <TableRow label="Kilo AI" value="https://kilo.ai — ไม่ต้องใช้ key ก็สแกนได้" />
            <TableRow label="Google AI" value="https://aistudio.google.com/apikey — สมัครฟรี" />
          </tbody>
        </table>
      </div>

      <div>
        <SectionTitle>MCP Server (สำหรับ OpenClaw/HiClaw)</SectionTitle>
        <Paragraph>เพิ่ม config นี้ใน OpenClaw MCP settings:</Paragraph>
        <Code>{`{
  "mcpServers": {
    "bcproxyai": {
      "command": "node",
      "args": ["dist/mcp/server.js"],
      "cwd": "<path-to-bcproxyai>",
      "env": {
        "OPENROUTER_API_KEY": "sk-or-v1-xxxx",
        "BCPROXYAI_API_URL": "http://localhost:3333"
      }
    }
  }
}`}</Code>
      </div>

      <div>
        <SectionTitle>Reset ข้อมูล</SectionTitle>
        <Code>{`docker compose down
docker volume rm bcproxyai_bcproxyai-data
docker compose up -d`}</Code>
      </div>

      <div>
        <SectionTitle>รัน Tests</SectionTitle>
        <Code>{`npm test            # รัน unit tests (67 tests)
npm run test:watch  # รัน tests แบบ watch mode`}</Code>
      </div>
    </div>
  );
}

// ─── Tab: API Reference ──────────────────────────────────────────────────────

function ApiGuide() {
  return (
    <div className="space-y-6">
      <div>
        <SectionTitle>Gateway (OpenAI Compatible)</SectionTitle>
        <table className="w-full mb-4">
          <thead>
            <tr className="border-b border-white/10 text-xs text-gray-500">
              <th className="py-2 text-left">Method</th>
              <th className="py-2 text-left">Path</th>
              <th className="py-2 text-left">คำอธิบาย</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-white/5">
              <td className="py-2 text-sm text-emerald-300 font-mono">POST</td>
              <td className="py-2 text-sm text-indigo-300 font-mono">/v1/chat/completions</td>
              <td className="py-2 text-sm text-gray-400">ส่งข้อความแชท (รองรับ stream)</td>
            </tr>
            <tr className="border-b border-white/5">
              <td className="py-2 text-sm text-blue-300 font-mono">GET</td>
              <td className="py-2 text-sm text-indigo-300 font-mono">/v1/models</td>
              <td className="py-2 text-sm text-gray-400">รายชื่อโมเดลทั้งหมด + สถานะ</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div>
        <SubTitle>ตัวอย่าง: ส่งข้อความ (ไม่ stream)</SubTitle>
        <Code>{`curl -X POST http://localhost:3333/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "auto",
    "messages": [{"role": "user", "content": "สวัสดีครับ"}],
    "stream": false
  }'`}</Code>
      </div>

      <div>
        <SubTitle>ตัวอย่าง: Stream</SubTitle>
        <Code>{`curl -X POST http://localhost:3333/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "auto",
    "messages": [{"role": "user", "content": "สวัสดีครับ"}],
    "stream": true
  }'`}</Code>
      </div>

      <div>
        <SubTitle>ตัวอย่าง: ใช้ Tool Calling</SubTitle>
        <Code>{`curl -X POST http://localhost:3333/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "bcproxy/tools",
    "messages": [{"role": "user", "content": "วันนี้อากาศเป็นยังไง"}],
    "tools": [{
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "Get weather",
        "parameters": {"type": "object", "properties": {}}
      }
    }]
  }'`}</Code>
      </div>

      <div>
        <SubTitle>ตัวอย่าง: ส่งรูปภาพ (Vision)</SubTitle>
        <Code>{`curl -X POST http://localhost:3333/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "auto",
    "messages": [{
      "role": "user",
      "content": [
        {"type": "text", "text": "อธิบายรูปนี้"},
        {"type": "image_url", "image_url": {"url": "https://..."}}
      ]
    }]
  }'`}</Code>
      </div>

      <div>
        <SectionTitle>Response Headers พิเศษ</SectionTitle>
        <table className="w-full">
          <tbody>
            <TableRow label="X-BCProxy-Model" value="โมเดลที่ถูกเลือกใช้จริง" />
            <TableRow label="X-BCProxy-Provider" value="ผู้ให้บริการ (openrouter/kilo/groq)" />
          </tbody>
        </table>
      </div>

      <div>
        <SectionTitle>Dashboard API</SectionTitle>
        <table className="w-full">
          <thead>
            <tr className="border-b border-white/10 text-xs text-gray-500">
              <th className="py-2 text-left">Method</th>
              <th className="py-2 text-left">Path</th>
              <th className="py-2 text-left">คำอธิบาย</th>
            </tr>
          </thead>
          <tbody>
            {[
              { method: "GET", path: "/api/status", desc: "สถานะ worker + สถิติ + โมเดลใหม่/หายไป" },
              { method: "GET", path: "/api/models", desc: "โมเดลทั้งหมด + health + benchmark" },
              { method: "GET", path: "/api/leaderboard", desc: "อันดับโมเดลตามคะแนน" },
              { method: "GET", path: "/api/worker", desc: "สถานะ worker" },
              { method: "POST", path: "/api/worker", desc: "สั่ง worker รันทันที" },
              { method: "POST", path: "/api/chat", desc: "Chat API สำหรับ Dashboard" },
            ].map((r) => (
              <tr key={r.path + r.method} className="border-b border-white/5">
                <td className="py-2 text-sm font-mono" style={{ color: r.method === "POST" ? "#6ee7b7" : "#93c5fd" }}>{r.method}</td>
                <td className="py-2 text-sm text-indigo-300 font-mono">{r.path}</td>
                <td className="py-2 text-sm text-gray-400">{r.desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Tab: แก้ไขปัญหา ────────────────────────────────────────────────────────

function TroubleshootGuide() {
  return (
    <div className="space-y-6">
      <div>
        <SectionTitle>Worker ไม่ทำงาน</SectionTitle>
        <Code>{`# ดู log ของ container
docker logs bcproxyai-bcproxyai-1

# สั่ง worker รันทันที
curl -X POST http://localhost:3333/api/worker`}</Code>
      </div>

      <div>
        <SectionTitle>ไม่มีโมเดลพร้อมใช้</SectionTitle>
        <ul className="list-disc list-inside text-sm text-gray-400 space-y-2 ml-2">
          <li>ตรวจสอบว่าใส่ API Key ใน <code className="text-indigo-300">.env.local</code> แล้ว</li>
          <li>รอ worker ทำ health check เสร็จ (ดูจาก Dashboard)</li>
          <li>โมเดลที่ติด rate limit จะพักอัตโนมัติ 2 ชม.</li>
          <li>กดปุ่ม &quot;รันตอนนี้&quot; บน Dashboard เพื่อสั่ง worker ทำงานทันที</li>
        </ul>
      </div>

      <div>
        <SectionTitle>Gateway ตอบ error</SectionTitle>
        <Code>{`# ทดสอบ gateway
curl -v -X POST http://localhost:3333/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -d '{"model":"auto","messages":[{"role":"user","content":"test"}]}'`}</Code>
        <ul className="list-disc list-inside text-sm text-gray-400 space-y-1 ml-2">
          <li>ดู <code className="text-indigo-300">X-BCProxy-Model</code> header เพื่อดูว่าเลือกโมเดลอะไร</li>
          <li>ถ้าไม่มีโมเดลพร้อมใช้ จะตอบ <code className="text-red-300">503</code></li>
          <li>ถ้าโมเดลตอบ error จะ fallback ไปตัวอื่น (สูงสุด 3 ครั้ง)</li>
        </ul>
      </div>

      <div>
        <SectionTitle>Docker build ไม่ผ่าน</SectionTitle>
        <ul className="list-disc list-inside text-sm text-gray-400 space-y-1 ml-2">
          <li>ตรวจสอบว่ามีไฟล์ <code className="text-indigo-300">.env.local</code> อยู่ (docker compose ต้องการ)</li>
          <li>ลอง <code className="text-indigo-300">docker compose build --no-cache</code></li>
          <li>ตรวจสอบ Docker Desktop ว่า engine กำลังทำงานอยู่</li>
        </ul>
      </div>

      <div>
        <SectionTitle>Reset ข้อมูลทั้งหมด</SectionTitle>
        <Code>{`docker compose down
docker volume rm bcproxyai_bcproxyai-data
docker compose up -d`}</Code>
        <Paragraph>จะลบ database ทั้งหมด แล้วเริ่มสแกนใหม่ตั้งแต่ต้น</Paragraph>
      </div>

      <div>
        <SectionTitle>การพัฒนาต่อ</SectionTitle>
        <ul className="list-decimal list-inside text-sm text-gray-400 space-y-2 ml-2">
          <li><span className="text-white">เพิ่ม API Key Authentication</span> — เพิ่ม middleware ตรวจ Bearer token ที่ <code className="text-indigo-300">/v1/*</code> routes</li>
          <li><span className="text-white">เพิ่ม Provider ใหม่</span> — เพิ่มฟังก์ชัน fetch ใน <code className="text-indigo-300">scanner.ts</code> + URL ใน <code className="text-indigo-300">health.ts</code></li>
          <li><span className="text-white">ปรับคำถาม Benchmark</span> — แก้ตัวแปร <code className="text-indigo-300">QUESTIONS</code> ใน <code className="text-indigo-300">benchmark.ts</code></li>
          <li><span className="text-white">เปลี่ยนเวลา Worker</span> — แก้ <code className="text-indigo-300">setInterval</code> ใน <code className="text-indigo-300">index.ts</code></li>
        </ul>
      </div>
    </div>
  );
}

// ─── Main Modal ──────────────────────────────────────────────────────────────

export function GuideModal({ onClose }: { onClose: () => void }) {
  const [activeTab, setActiveTab] = useState<TabId>("usage");

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />
      <div
        className="relative w-full max-w-4xl max-h-[85vh] glass-bright rounded-2xl border border-indigo-500/20 overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/5 bg-gray-900/50 shrink-0">
          <div className="flex items-center gap-3">
            <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-indigo-500 to-cyan-500 flex items-center justify-center">
              <svg className="h-4 w-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
              </svg>
            </div>
            <div>
              <h2 className="text-lg font-bold text-white">คู่มือ BCProxyAI</h2>
              <p className="text-xs text-gray-500">Smart AI Gateway</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg text-gray-400 hover:text-white hover:bg-white/10 transition-colors"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 px-6 py-2 border-b border-white/5 bg-gray-900/30 shrink-0 overflow-x-auto">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors whitespace-nowrap ${
                activeTab === tab.id
                  ? "bg-indigo-500/20 text-indigo-300 border border-indigo-500/30"
                  : "text-gray-400 hover:text-white hover:bg-white/5"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {activeTab === "usage" && <UsageGuide />}
          {activeTab === "install" && <InstallGuide />}
          {activeTab === "api" && <ApiGuide />}
          {activeTab === "troubleshoot" && <TroubleshootGuide />}
        </div>
      </div>
    </div>
  );
}
