// Node 下运行浏览器相关模块的最小垫片
class MemoryStorage {
  constructor() { this.map = new Map() }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null }
  setItem(key, value) { this.map.set(key, String(value)) }
  removeItem(key) { this.map.delete(key) }
  clear() { this.map.clear() }
}
globalThis.localStorage = new MemoryStorage()
globalThis.window = { setTimeout, clearTimeout }
