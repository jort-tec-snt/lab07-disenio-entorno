const express = require('express');
const session = require('express-session');
const PgStore = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const { randomBytes, scrypt, timingSafeEqual } = require('node:crypto');
const { promisify } = require('node:util');
const path = require('node:path');
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

function page(title, content, { req, login = false } = {}) {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} | Lab 07</title>
<link rel="stylesheet" href="/assets/styles.css">
<script src="/assets/app.js" defer></script>
</head>
<body class="${login ? 'login-page' : 'dashboard-page'}">
<main class="shell ${login ? 'login-shell' : ''}">
${login ? '' : `<header class="topbar">
  <div class="brand"><span class="brand-mark">L</span><div><span class="brand-name">Lab 07</span><span class="brand-subtitle">Gestión de productos</span></div></div>
  ${req?.session?.user ? `<div class="account"><span>Sesión de <strong>${escapeHtml(req.session.user.username)}</strong></span>
    <form method="post" action="/logout">${csrfField(req)}<button class="button button-quiet" type="submit">Cerrar sesión</button></form></div>` : ''}
</header>`}
${content}
<footer class="site-footer"><span>Laboratorio 07 · Ortiz</span><span>Servidor que respondió: <strong>${escapeHtml(serverName)}</strong></span></footer>
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

app.use('/assets', express.static(path.join(__dirname, 'public')));

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
    <section class="login-card" aria-labelledby="login-title">
      <div class="login-emblem" aria-hidden="true">L</div>
      <p class="eyebrow">Lab 07 · Ortiz</p>
      <h1 id="login-title">Gestión de productos</h1>
      <p class="intro">Ingresa para administrar el catálogo del laboratorio.</p>
    ${req.query.error ? '<p class="alert alert-error" role="alert">Usuario o contraseña incorrectos. Inténtalo de nuevo.</p>' : ''}
    <form class="form-stack" method="post" action="/login">
      ${csrfField(req)}
      <label for="username">Usuario
        <input id="username" name="username" autocomplete="username" required maxlength="80" autofocus>
      </label>
      <label for="password">Contraseña</label>
      <div class="password-field"><input id="password" type="password" name="password"
          autocomplete="current-password" required maxlength="256">
        <button class="password-toggle" type="button" aria-controls="password" aria-label="Mostrar contraseña" aria-pressed="false">Mostrar</button>
      </div>
      <button class="button button-primary button-full" type="submit">Ingresar</button>
    </form></section>`, { login: true }));
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
    <section class="content-card form-card">
    <div class="section-heading"><div><p class="eyebrow">Catálogo / ${editing ? 'Editar' : 'Nuevo'}</p>
    <h1>${editing ? 'Editar producto' : 'Crear producto'}</h1>
    <p class="section-description">${editing ? 'Actualiza la información del producto.' : 'Completa los datos para agregar un producto al catálogo.'}</p></div></div>
    <form class="form-stack" method="post"
      action="${editing ? `/products/${product.id}/edit` : '/products'}">
      ${csrfField(req)}
      <label for="name">Nombre del producto
        <input id="name" name="name" required maxlength="120"
          value="${escapeHtml(product.name || '')}">
      </label>
      <div class="form-grid"><label for="price">Precio en soles (S/)
        <input id="price" type="number" name="price" min="0" max="999999.99"
          step="0.01" required value="${escapeHtml(product.price ?? '')}">
      </label>
      <label for="stock">Unidades en stock
        <input id="stock" type="number" name="stock" min="0" max="1000000"
          step="1" required value="${escapeHtml(product.stock ?? '')}">
      </label></div>
      <div class="form-actions"><button class="button button-primary" type="submit">Guardar producto</button>
      <a class="button button-secondary" href="/products">Cancelar</a></div>
    </form></section>`;
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
  const stockTotal = rows.reduce((sum, product) => sum + Number(product.stock), 0);
  const flash = req.session.flash;
  delete req.session.flash;
  res.send(page('Productos', `
    <section class="page-heading"><div><p class="eyebrow">Panel de control</p><h1>Productos</h1>
      <p class="section-description">Administra tu catálogo y mantén el inventario al día.</p></div>
      <a class="button button-primary" href="/products/new"><span aria-hidden="true">＋</span> Crear producto</a></section>
    ${flash ? `<p class="alert alert-success" role="status">${escapeHtml(flash)}</p>` : ''}
    <section class="metrics" aria-label="Resumen del inventario">
      <div class="metric"><span class="metric-label">Productos registrados</span><strong>${rows.length}</strong><span class="metric-note">En el catálogo</span></div>
      <div class="metric"><span class="metric-label">Unidades en stock</span><strong>${stockTotal}</strong><span class="metric-note">Disponibles en total</span></div>
    </section>
    <section class="content-card"><div class="section-heading"><div><h2>Inventario</h2>
      <p class="section-description">Consulta y actualiza los productos registrados.</p></div>
      <span class="count-badge">${rows.length} ${rows.length === 1 ? 'producto' : 'productos'}</span></div>
    ${rows.length ? `<div class="table-scroll"><table>
      <thead><tr><th scope="col">N.º</th><th scope="col">Producto</th><th scope="col">Precio</th>
        <th scope="col">Stock</th><th scope="col">Acciones</th></tr></thead>
      <tbody>${rows.map((p, index) => `<tr>
        <td class="row-number">${index + 1}</td><td class="product-name">${escapeHtml(p.name)}</td>
        <td>S/ ${escapeHtml(p.price)}</td><td><span class="stock-badge">${p.stock} unidades</span></td>
        <td><div class="row-actions">
          <a class="button button-edit" href="/products/${p.id}/edit">Editar</a>
          <form method="post" action="/products/${p.id}/delete" data-confirm-delete>
            ${csrfField(req)}<button class="button button-delete" type="submit">Eliminar</button>
          </form>
        </div></td></tr>`).join('')}
      </tbody></table></div>` : `<div class="empty-state"><div class="empty-icon" aria-hidden="true">▤</div>
        <h3>Aún no hay productos</h3><p>Empieza agregando el primer producto al catálogo.</p>
        <a class="button button-primary" href="/products/new">Crear producto</a></div>`}</section>`, { req }));
});

app.get('/products/new', (req, res) => {
  res.send(page('Crear producto', productForm(req), { req }));
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
  req.session.flash = 'Producto creado correctamente.';
  res.redirect('/products');
});

app.get('/products/:id/edit', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM products WHERE id=$1', [req.params.id]
  );
  if (!rows[0]) return res.sendStatus(404);
  res.send(page('Editar producto', productForm(req, rows[0]), { req }));
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
  req.session.flash = 'Producto actualizado correctamente.';
  res.redirect('/products');
});

app.post('/products/:id/delete', async (req, res) => {
  const result = await pool.query(
    'DELETE FROM products WHERE id=$1', [req.params.id]
  );
  if (!result.rowCount) return res.sendStatus(404);
  req.session.flash = 'Producto eliminado correctamente.';
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
