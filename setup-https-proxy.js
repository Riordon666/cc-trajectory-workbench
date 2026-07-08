/**
 * 生成自签名 HTTPS 证书
 * 用于 MITM 代理拦截 HTTPS 流量
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const certDir = path.join(__dirname, 'certs');
const certFile = path.join(certDir, 'cert.pem');
const keyFile = path.join(certDir, 'key.pem');

console.log('🔐 设置 HTTPS 代理证书...\n');

// 创建证书目录
if (!fs.existsSync(certDir)) {
  fs.mkdirSync(certDir);
  console.log('✓ 创建证书目录');
}

// 检查证书是否存在
if (fs.existsSync(certFile) && fs.existsSync(keyFile)) {
  console.log('✓ 证书已存在，使用现有证书');
  process.exit(0);
}

// 生成自签名证书（有效期 365 天，支持任意域名）
console.log('⏳ 生成自签名证书（通配 SAN）...');

try {
  // 使用 SAN 扩展让证书对任意域名都有效（MITM 代理用途）
  const opensslConf = path.join(certDir, 'openssl.cnf');
  fs.writeFileSync(opensslConf, `
[req]
default_bits = 2048
prompt = no
default_md = sha256
distinguished_name = dn
x509_extensions = v3_ext

[dn]
CN = MITM Proxy CA

[v3_ext]
basicConstraints = critical, CA:TRUE
keyUsage = critical, keyCertSign, cRLSign, digitalSignature
subjectAltName = DNS:*
`);

  execSync(`openssl req -x509 -newkey rsa:2048 -keyout "${keyFile}" -out "${certFile}" -days 365 -nodes -config "${opensslConf}"`, {
    stdio: 'inherit'
  });

  // 清理临时配置
  fs.unlinkSync(opensslConf);
  
  console.log('\n✓ 证书生成成功:');
  console.log(`  • 证书: ${certFile}`);
  console.log(`  • 密钥: ${keyFile}`);
  
  // 信任证书（macOS）
  console.log('\n⚙️  配置证书信任...');
  try {
    execSync(`sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ${certFile}`, {
      stdio: 'inherit'
    });
    console.log('✓ 已添加到系统信任证书（macOS）');
  } catch (e) {
    console.log('⚠️  需要手动信任证书（见下面步骤）');
  }
  
  console.log('\n📌 手动信任步骤（如需）:');
  console.log('  macOS: 在 Keychain Access 中打开证书，设为 "Always Trust"');
  console.log('  Linux: sudo cp cert.pem /usr/local/share/ca-certificates/ && sudo update-ca-certificates');
  console.log('  Windows: certutil -addstore -f "Root" cert.pem');
  
} catch (error) {
  console.error('❌ 证书生成失败:', error.message);
  process.exit(1);
}
