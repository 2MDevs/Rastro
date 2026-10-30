// Ambiente dos testes automáticos: banco próprio de teste, e-mails em memória, limites altos.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgresql://rastro:rastro_local_dev@127.0.0.1:5432/rastro_test';
process.env.MAIL_TRANSPORT = 'memory';
process.env.SETTINGS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.DEVELOPER_EMAILS = 'dev@teste.local';
process.env.AUTH_RATE_LIMIT = '100000';
process.env.APP_URL = 'http://localhost';
