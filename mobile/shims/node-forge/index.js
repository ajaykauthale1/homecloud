const crypto = require('crypto');

module.exports = {
  pki: {
    certificateFromPem: () => ({}),
    privateKeyFromPem: () => ({}),
    publicKeyFromPem: () => ({}),
    certificateToPem: () => '',
    privateKeyToPem: () => '',
    publicKeyToPem: () => ''
  },
  md: {
    sha256: {
      create: () => {
        const h = crypto.createHash('sha256');
        return {
          update: (d) => {
            h.update(d);
            return this;
          },
          digest: () => ({ toHex: () => h.digest('hex') })
        };
      }
    }
  },
  util: {
    encode64: (b) => Buffer.from(b).toString('base64'),
    decode64: (s) => Buffer.from(s, 'base64').toString('binary')
  }
};
