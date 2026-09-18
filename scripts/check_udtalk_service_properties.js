const {
  ServicePropertiesMonitor,
  publicError,
} = require('../modules/monitoring/udtalk_service_properties');

async function main({ args = process.argv.slice(2), monitor, log = console.log } = {}) {
  if (args.some(arg => arg !== '--dry-run')) {
    log(JSON.stringify({ error: { code: 'INVALID_ARGUMENT', message: '指定できる引数は--dry-runのみです。' } }));
    return 2;
  }
  try {
    const result = await (monitor || new ServicePropertiesMonitor()).check({
      notify: !args.includes('--dry-run'),
    });
    log(JSON.stringify(result));
    return result.ok ? 0 : 1;
  } catch (error) {
    log(JSON.stringify({ error: publicError(error), result: error.result }));
    return 2;
  }
}

if (require.main === module) {
  require('dotenv').config();
  main().then(code => { process.exitCode = code; });
}

module.exports = { main };
