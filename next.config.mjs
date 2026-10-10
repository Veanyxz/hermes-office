/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // three.js ships ESM examples; let Next transpile them for the browser bundle
  transpilePackages: ['three'],
  // Dev (`hermes verify` starts it too) must not share .next with the production
  // build: mixed dev+prod artifacts made `next start` serve 500/404. Next sets
  // NODE_ENV=development itself for the `dev` command (next/dist/bin/next
  // preAction hook), so only dev gets its own directory — no env prefix needed
  // in the npm script, and none works on Windows cmd.exe anyway.
  distDir: process.env.NODE_ENV === 'development' ? '.next-dev' : '.next',
  // Next 16 menulis AGENTS.md ("This is NOT the Next.js you know") ke root tiap
  // `next dev`. Artefak itu men-spam working tree di setiap run dan isinya cuma
  // catatan untuk AI agent — repo ini bukan target penulisan kode otomatis.
  agentRules: false,
}

export default nextConfig
