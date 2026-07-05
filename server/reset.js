'use strict';
const store = require('./store');
store.reset()
  .then(() => console.log(`Base réinitialisée (${store._internal.CLOUD ? 'cloud' : 'fichier local'}).`))
  .catch((e) => { console.error(e.message); process.exit(1); });
