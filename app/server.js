const express = require('express');
const session = require('express-session');
const PgStore = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const { randomBytes, scrypt, timingSafeEqual } = require('node:crypto');
const { promisify } = require('node:util');
const os = require('node:os');

const deriveKey = promisify(scrypt);
const app = express();
const pool = new Pool({
  host: process.env.PGHOST || 'db',
  port: Number(process.env.PGPORT || 5432),
  database: process.env.POSTGRES_DB,
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD
});
const serverName = process.env.SERVER_NAME || os.hostname();

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;',
    '"': '&quot;', "'": '&#39;'
  })[c]);
}

function page(title, content) {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} | Lab 07</title>
<style>
*{box-sizing:border-box}
body{font-family:system-ui,sans-serif;background:#eef2f6;color:#172337;
margin:0;padding:32px 16px}
main{max-width:1000px;margin:auto;background:white;padding:28px;
border-radius:16px;box-shadow:0 8px 30px #17233712}
header{border-bottom:1px solid #dde4ed;margin-bottom:24px;padding-bottom:16px}
h1{margin:0 0 8px} h2{font-size:20px}
small{color:#54657b} label{display:block;margin:12px 0}
input{display:block;width:100%;padding:10px;margin-top:6px;
border:1px solid #bbc8d8;border-radius:6px}
button,a.button{background:#1749b5;color:white;border:0;border-radius:6px;
padding:10px 14px;cursor:pointer;text-decoration:none;display:inline-block}
button.danger{background:#b42335}
table{width:100%;border-collapse:collapse;margin:18px 0}
th,td{text-align:left;padding:12px;border-bottom:1px solid #dde4ed}
.actions{display:flex;gap:8px;flex-wrap:wrap}
.actions form{margin:0}
.notice{color:#b42335}
footer{margin-top:24px;color:#54657b}
</style>
</head>
<body><main>
<header><h1>Gestión de productos</h1>
<small>Laboratorio 07 · LOGIN + CRUD · Ortiz</small></header>
${content}
<footer>Servidor que respondió: <strong>${escapeHtml(serverName)}</strong></footer>
</main></body></html>`;
}

function csrfField(req) {
  return `<input type="hidden" name="_csrf" value="${req.session.csrf}">`;
}

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Cache-Control', 'no-store');
  res.set('X-Backend', serverName);
  next();
});

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', server: serverName });
  } catch {
    res.status(503).json({ status: 'unavailable' });
  }
});

app.use(express.urlencoded({ extended: false, limit: '16kb' }));
app.use(session({
  name: 'lab07.sid',
  store: new PgStore({ pool, createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: false,
    maxAge: 60 * 60 * 1000
  }
}));

app.use((req, res, next) => {
  req.session.csrf ||= randomBytes(32).toString('hex');
  if (req.method === 'POST' && req.body._csrf !== req.session.csrf) {
    return res.status(403).send(page('Solicitud rechazada',
      '<p>Token del formulario inválido. Regresa y recarga la página.</p>'));
  }
  next();
});

function requireLogin(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
}

app.get('/', (req, res) => {
  res.redirect(req.session.user ? '/products' : '/login');
});

app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/products');
  res.send(page('Iniciar sesión', `
    <h2>Iniciar sesión</h2>
    ${req.query.error ? '<p class="notice">Usuario o contraseña incorrectos.</p>' : ''}
    <form method="post" action="/login">
      ${csrfField(req)}
      <label>Usuario
        <input name="username" autocomplete="username" required maxlength="80">
      </label>
      <label>Contraseña
        <input type="password" name="password"
          autocomplete="current-password" required maxlength="256">
      </label>
      <button>Ingresar</button>
    </form>`));
});

app.post('/login', async (req, res, next) => {
  const { rows } = await pool.query(
    'SELECT id, username, salt, password_hash FROM users WHERE username=$1',
    [String(req.body.username || '')]
  );
  const user = rows[0];
  const salt = user ? user.salt : '00000000000000000000000000000000';
  const hash = await deriveKey(String(req.body.password || ''), salt, 64);
  if (!user || !timingSafeEqual(hash, Buffer.from(user.password_hash, 'hex'))) {
    return res.redirect('/login?error=1');
  }
  req.session.regenerate(error => {
    if (error) return next(error);
    req.session.user = { id: user.id, username: user.username };
    req.session.csrf = randomBytes(32).toString('hex');
    req.session.save(error => {
      if (error) return next(error);
      res.redirect('/products');
    });
  });
});

app.post('/logout', requireLogin, (req, res, next) => {
  req.session.destroy(error => {
    if (error) return next(error);
    res.clearCookie('lab07.sid');
    res.redirect('/login');
  });
});

function productForm(req, product = {}) {
  const editing = product.id !== undefined;
  return `
    <h2>${editing ? 'Editar producto' : 'Crear producto'}</h2>
    <form method="post"
      action="${editing ? `/products/${product.id}/edit` : '/products'}">
      ${csrfField(req)}
      <label>Nombre
        <input name="name" required maxlength="120"
          value="${escapeHtml(product.name || '')}">
      </label>
      <label>Precio en soles
        <input type="number" name="price" min="0" max="999999.99"
          step="0.01" required value="${escapeHtml(product.price ?? '')}">
      </label>
      <label>Stock
        <input type="number" name="stock" min="0" max="1000000"
          step="1" required value="${escapeHtml(product.stock ?? '')}">
      </label>
      <button>Guardar</button>
      <a href="/products">Volver</a>
    </form>`;
}

function productValues(req) {
  const name = String(req.body.name || '').trim();
  const priceText = String(req.body.price || '').trim();
  const stockText = String(req.body.stock || '').trim();
  const price = Number(priceText);
  const stock = Number(stockText);
  if (!name || name.length > 120 ||
      !/^\d+(\.\d{1,2})?$/.test(priceText) ||
      price > 999999.99 ||
      !/^\d+$/.test(stockText) ||
      !Number.isInteger(stock) || stock > 1000000) {
    return null;
  }
  return [name, priceText, stock];
}

app.use('/products', requireLogin);

app.get('/products', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM products ORDER BY id');
  res.send(page('Productos', `
    <div class="actions">
      <a class="button" href="/products/new">Crear producto</a>
      <form method="post" action="/logout">
        ${csrfField(req)}<button>Cerrar sesión</button>
      </form>
    </div>
    <p>Sesión de <strong>${escapeHtml(req.session.user.username)}</strong></p>
    <div style="overflow-x:auto"><table>
      <thead><tr><th>N.º</th><th>Producto</th><th>Precio S/</th>
        <th>Stock</th><th>Acciones</th></tr></thead>
      <tbody>${rows.map((p, index) => `<tr>
        <td>${index + 1}</td><td>${escapeHtml(p.name)}</td>
        <td>${escapeHtml(p.price)}</td><td>${p.stock}</td>
        <td><div class="actions">
          <a class="button" href="/products/${p.id}/edit">Editar</a>
          <form method="post" action="/products/${p.id}/delete">
            ${csrfField(req)}<button class="danger">Eliminar</button>
          </form>
        </div></td></tr>`).join('') ||
        '<tr><td colspan="5">Todavía no hay productos.</td></tr>'}
      </tbody></table></div>`));
});

app.get('/products/new', (req, res) => {
  res.send(page('Crear producto', productForm(req)));
});

app.param('id', (req, res, next, id) => {
  if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id)) ||
      Number(id) > 2147483647) {
    return res.sendStatus(404);
  }
  next();
});

app.post('/products', async (req, res) => {
  const values = productValues(req);
  if (!values) return res.status(400).send(page('Datos inválidos',
    '<p>Revisa el nombre, precio y stock.</p><a href="/products/new">Volver</a>'));
  await pool.query(
    'INSERT INTO products (name, price, stock) VALUES ($1,$2,$3)', values
  );
  res.redirect('/products');
});

app.get('/products/:id/edit', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM products WHERE id=$1', [req.params.id]
  );
  if (!rows[0]) return res.sendStatus(404);
  res.send(page('Editar producto', productForm(req, rows[0])));
});

app.post('/products/:id/edit', async (req, res) => {
  const values = productValues(req);
  if (!values) return res.status(400).send(page('Datos inválidos',
    '<p>Revisa el nombre, precio y stock.</p><a href="/products">Volver</a>'));
  const result = await pool.query(
    'UPDATE products SET name=$1, price=$2, stock=$3 WHERE id=$4',
    [...values, req.params.id]
  );
  if (!result.rowCount) return res.sendStatus(404);
  res.redirect('/products');
});

app.post('/products/:id/delete', async (req, res) => {
  const result = await pool.query(
    'DELETE FROM products WHERE id=$1', [req.params.id]
  );
  if (!result.rowCount) return res.sendStatus(404);
  res.redirect('/products');
});

app.use((error, req, res, next) => {
  console.error('Error de aplicación:', error.message);
  res.status(500).send(page('Error', '<p>No se pudo completar la operación.</p>'));
});

async function start() {
  if (!process.env.SESSION_SECRET || !process.env.ADMIN_PASSWORD) {
    throw new Error('Faltan SESSION_SECRET o ADMIN_PASSWORD');
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(80) UNIQUE NOT NULL,
      salt TEXT NOT NULL,
      password_hash TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      name VARCHAR(120) NOT NULL,
      price NUMERIC(8,2) NOT NULL CHECK (price >= 0),
      stock INTEGER NOT NULL CHECK (stock >= 0)
    );
  `);
  const salt = randomBytes(16).toString('hex');
  const hash = await deriveKey(process.env.ADMIN_PASSWORD, salt, 64);
  await pool.query(
    `INSERT INTO users (username, salt, password_hash)
     VALUES ($1,$2,$3) ON CONFLICT (username) DO NOTHING`,
    ['ortiz', salt, hash.toString('hex')]
  );
  app.listen(3000, '0.0.0.0', () => {
    console.log(`Aplicación disponible en puerto 3000. Servidor: ${serverName}`);
  });
}

start().catch(error => {
  console.error('Fallo de inicio:', error.message);
  process.exit(1);
});
