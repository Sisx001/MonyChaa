module.exports = {
  apps: [
    {
      name: 'secretary-pro',
      script: 'src/index.js',
      instances: 1,
      autorestart: true,
      max_restarts: 20,
      restart_delay: 3000,
      max_memory_restart: '400M',
      env: { NODE_ENV: 'production' },
      error_file: './data/pm2-error.log',
      out_file: './data/pm2-out.log',
      merge_logs: true,
      time: true,
    },
  ],
};
