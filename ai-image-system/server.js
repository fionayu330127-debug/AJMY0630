// server.js — AI作图模块（独立服务）
const express = require('express');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const aiImageRouter = require('./routes/ai-image');

const DATA_DIR = path.join(__dirname, 'data');
const TASKS_FILE = path.join(DATA_DIR, 'ai-image-tasks.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readTasks() {
  ensureDataDir();
  if (!fs.existsSync(TASKS_FILE)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeTasks(tasks) {
  ensureDataDir();
  fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2), 'utf8');
}

function normalizeTask(task) {
  return {
    id: task.id,
    task_name: task.task_name,
    submitter_id: task.submitter_id || 1,
    submitter_name: task.submitter_name || 'AI Image User',
    created_at: task.created_at,
    updated_at: task.updated_at,
    draft: task.draft && typeof task.draft === 'object' ? task.draft : null,
  };
}

const app = express();
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = process.env.PORT || 3002; // 跟 tk-creator-system(3001) 错开，避免端口冲突

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: '20mb' }));
app.use(express.static(PUBLIC_DIR));

function getTasks(req, res) {
  const tasks = readTasks()
    .map(normalizeTask)
    .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')) || Number(b.id) - Number(a.id));
  res.json({
    is_admin: true,
    current_user: { id: 1, name: 'AI Image User', role: 'admin' },
    tasks,
  });
}

function createTask(req, res) {
  const taskName = String(req.body.task_name || '').trim();
  if (!taskName) return res.status(400).json({ error: 'Please enter a task name' });

  const tasks = readTasks();
  const now = new Date().toISOString();
  const nextId = tasks.reduce((max, task) => Math.max(max, Number(task.id) || 0), 0) + 1;
  const task = normalizeTask({
    id: nextId,
    task_name: taskName,
    submitter_id: 1,
    submitter_name: 'AI Image User',
    created_at: now,
    updated_at: now,
    draft: req.body.draft && typeof req.body.draft === 'object' ? req.body.draft : null,
  });
  tasks.push(task);
  writeTasks(tasks);
  res.json({ ok: true, task });
}

function updateTask(req, res) {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'Task not found' });

  const tasks = readTasks();
  const index = tasks.findIndex((task) => Number(task.id) === id);
  if (index < 0) return res.status(404).json({ error: 'Task not found' });

  const hasTaskName = Object.prototype.hasOwnProperty.call(req.body, 'task_name');
  const hasDraft = Object.prototype.hasOwnProperty.call(req.body, 'draft');
  const taskName = hasTaskName ? String(req.body.task_name || '').trim() : tasks[index].task_name;
  if (hasTaskName && !taskName) return res.status(400).json({ error: 'Please enter a task name' });
  if (!hasTaskName && !hasDraft) return res.status(400).json({ error: 'Nothing to update' });

  tasks[index] = normalizeTask({
    ...tasks[index],
    task_name: taskName,
    draft: hasDraft
      ? (req.body.draft && typeof req.body.draft === 'object' ? req.body.draft : null)
      : tasks[index].draft,
    updated_at: new Date().toISOString(),
  });
  writeTasks(tasks);
  res.json({ ok: true, task: tasks[index] });
}

function deleteTask(req, res) {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'Task not found' });

  const tasks = readTasks();
  const nextTasks = tasks.filter((task) => Number(task.id) !== id);
  if (nextTasks.length === tasks.length) return res.status(404).json({ error: 'Task not found' });

  writeTasks(nextTasks);
  res.json({ ok: true });
}

app.get('/api/ai-image/tasks', getTasks);
app.post('/api/ai-image/tasks', createTask);
app.patch('/api/ai-image/tasks/:id', updateTask);
app.delete('/api/ai-image/tasks/:id', deleteTask);
app.use('/api/ai-image', aiImageRouter);

app.get('/api/ai-draw/tasks', getTasks);
app.post('/api/ai-draw/tasks', createTask);
app.patch('/api/ai-draw/tasks/:id', updateTask);
app.delete('/api/ai-draw/tasks/:id', deleteTask);

app.get('/ai-draw/api/ai-image/tasks', getTasks);
app.post('/ai-draw/api/ai-image/tasks', createTask);
app.patch('/ai-draw/api/ai-image/tasks/:id', updateTask);
app.delete('/ai-draw/api/ai-image/tasks/:id', deleteTask);
app.get('/api/tasks', getTasks);
app.post('/api/tasks', createTask);
app.patch('/api/tasks/:id', updateTask);
app.delete('/api/tasks/:id', deleteTask);

app.use('/ai-draw/api/ai-image', aiImageRouter);
app.use('/ai-draw', express.static(PUBLIC_DIR));
app.get('/ai-draw/*', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

app.use('/api', (req, res) => {
  res.status(404).json({ error: `API not found: ${req.originalUrl}` });
});

app.get('/health', (req, res) => res.json({ ok: true, module: 'ai-image-system' }));

if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`AI作图模块 running at http://127.0.0.1:${PORT}`);
  });
}

module.exports = app;
