/* 怪啖论坛 · IP 归属地离线查询（ip2region xdb，零依赖）
 * 数据文件 geo/ip2region.xdb（IPv4 全量库，约 11MB，随仓库分发到服务器）
 * 来源：github.com/lionsoul2014/ip2region（MIT License）；
 *       文件头 version=3，段索引结构与 v2 搜索算法兼容（14 字节/条目，LE）。
 * search(ip) 返回原始「国家|区域|城市|ISP|代码」字符串；未加载 / 非 IPv4 / 查不到返回 null。
 * 整个文件一次性载入内存（约 11MB），查询为微秒级二分；由 server-root.js 调用并整理展示格式。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const VECTOR_INDEX_SIZE = 8;   /* 向量索引每槽 8 字节：起止指针各 4 字节 LE */
const VECTOR_INDEX_COLS = 256; /* 向量索引按 IP 前两段 256×256 分槽 */
const SEGMENT_INDEX_SIZE = 14; /* 段索引每条 14 字节：起IP4 + 止IP4 + 数据长2 + 数据指针4 */

let buf = null;

function init(geoDir) {
  const file = path.join(geoDir || path.join(__dirname, 'geo'), 'ip2region.xdb');
  try {
    const stat = fs.statSync(file);
    buf = Buffer.alloc(stat.size);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, stat.size, 0); } finally { fs.close(fd); }
    console.log('[geo] ip2region.xdb 已载入：' + (stat.size / 1024 / 1024).toFixed(1) + ' MB');
    return true;
  } catch (err) {
    buf = null;
    console.error('[geo] ip2region.xdb 加载失败（归属地将显示未知）：' + err.message);
    return false;
  }
}

const isIPv4 = ip => /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(String(ip));

function search(ip) {
  if (!buf || !isIPv4(ip)) return null;
  const ps = ip.split('.').map(Number);
  if (ps.some(n => n > 255)) return null;
  const ipInt = ps[0] * 16777216 + ps[1] * 65536 + ps[2] * 256 + ps[3];
  const idx = ps[0] * VECTOR_INDEX_COLS * VECTOR_INDEX_SIZE + ps[1] * VECTOR_INDEX_SIZE;
  const sPtr = buf.readUInt32LE(256 + idx);
  const ePtr = buf.readUInt32LE(256 + idx + 4);
  let l = 0;
  let h = (ePtr - sPtr) / SEGMENT_INDEX_SIZE;
  while (l <= h) {
    const m = (l + h) >> 1;
    const p = sPtr + m * SEGMENT_INDEX_SIZE;
    const sip = buf.readUInt32LE(p);
    if (ipInt < sip) { h = m - 1; continue; }
    if (ipInt > buf.readUInt32LE(p + 4)) { l = m + 1; continue; }
    const dataLen = buf.readUInt16LE(p + 8);
    const dataPtr = buf.readUInt32LE(p + 10);
    return buf.toString('utf8', dataPtr, dataPtr + dataLen);
  }
  return null;
}

module.exports = { init, search, isIPv4 };
