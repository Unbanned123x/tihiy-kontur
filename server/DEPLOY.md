# Деплой сервера на Render

Репозиторий: https://github.com/unbanned123x/tihiy-kontur
Код сервера лежит в папке `server/`, манифест — `server/render.yaml`.

## Шаги

1. Откройте https://dashboard.render.com/register и войдите через **GitHub**
   (аккаунт `unbanned123x`). Карта не нужна.
2. В дашборде: **New → Blueprint**.
3. Выберите репозиторий `tihiy-kontur` → **Connect**.
   Render сам прочитает `server/render.yaml`.
4. Нажмите **Apply**. Он создаст веб-сервис `tihiy-kontur-server` на плане Free.
5. В разделе **Environment** добавьте переменные:
   - `DP_KEY` — ключ DonatePay (из кабинета DonatePay → API);
   - `PUBLIC_URL` — адрес сервиса после первого деплоя, например
     `https://tihiy-kontur-server.onrender.com`.
   `AUTH_DEV` уже стоит в `0` — ссылка подтверждения не будет показываться на экране.
6. Дождитесь статуса **Live** (1–2 минуты).
7. Проверьте:
   - `https://<имя>.onrender.com/health` → `{"ok":true,...}`
   - `https://<имя>.onrender.com/api/donations` → `{"top":[],...}`

## После деплоя

Пришлите адрес сервиса — я впишу его в двух местах:

- `site/index.html` → `DONATIONS_API` (таблица донатов);
- `site/account.html` → `API` (формы входа и регистрации).

## Ограничения бесплатного тарифа — важно

| Что | Как ведёт себя |
|---|---|
| Сон | Сервис засыпает через 15 минут **без трафика**. Первый запрос после сна — до 60 с. |
| WebSocket | Активное соединение считается трафиком, поэтому комната в игре держит сервис живым. |
| **Файловая система** | **Временная.** `users.json` переживёт перезапуск процесса, но **пропадёт** при каждом новом деплое или перезапуске контейнера. |
| Память | Комнаты и сессии живут только в RAM, после сна обнуляются. |

### Что делать с пользователями

Аккаунты в `users.json` на Free-плане недолговечны. Варианты:

1. **Neon Postgres** (бесплатный тариф) — постоянная база, нужен аккаунт, 10 минут работы.
2. **Render Disk** — платно, 1 ГБ от $0.25/мес.
3. **Оставить как есть** — тогда при каждом деплое все аккаунты теряются.
   Для донатов это неприемлемо: человек заплатит, а аккаунта не станет.

Для денег правильный путь — пункт 1. Могу переписать хранилище на Postgres,
когда будете готовы.

## Переменные окружения

| Переменная | Назначение | Обязательна |
|---|---|---|
| `PORT` | Render задаёт сам | нет |
| `DP_KEY` | ключ DonatePay для таблицы донатов | да, для донатов |
| `PUBLIC_URL` | публичный адрес, для ссылок в письмах | да |
| `AUTH_DEV` | `1` — показывать ссылку подтверждения в ответе | нет |
| `SMTP_HOST` | зарезервировано под отправку писем | нет |

## Проверка после деплоя

```
curl https://<имя>.onrender.com/health
curl https://<имя>.onrender.com/api/donations
```

Регистрация и 2FA проверяются из `site/account.html` — достаточно открыть страницу
и создать тестовый аккаунт.


## Neon Postgres — постоянные аккаунты

Без базы аккаунты на Render Free теряются при каждом деплое. Neon закрывает это.

1. Откройте https://neon.tech → **Sign up** через GitHub.
2. **Create project**: имя `tihiy-kontur`, регион — Europe (Frankfurt) или ближайший.
3. В проекте: **Connection string** → формат `postgresql://user:pass@ep-xxx.region.aws.neon.tech/neondb?sslmode=require`.
4. В Render → ваш сервис → **Environment** → добавьте переменную:
   - `DATABASE_URL` = эта строка целиком.
5. Нажмите **Manual Deploy → Deploy latest commit**.

Таблица создастся сама при старте: сервер выполняет
`CREATE TABLE IF NOT EXISTS users (...)`.

### Как проверить

В логах Render при старте появится строка:

```
[db] Neon Postgres
```

Если вместо неё `[db] файл users.json` — переменная не подхватилась.

После этого создайте тестовый аккаунт на странице `account.html` и перезапустите
сервис (Manual Deploy). Если вход после перезапуска работает — база подключена верно.

### Как это устроено

`server/store.js` выбирает бэкенд по наличию `DATABASE_URL`:

| Условие | Хранилище |
|---|---|
| `DATABASE_URL` задан | Neon Postgres через HTTP (`POST /sql`), без npm-зависимостей |
| не задан | локальный `users.json` |

Схема таблицы:

```sql
CREATE TABLE IF NOT EXISTS users (
  email TEXT PRIMARY KEY,
  salt TEXT NOT NULL,
  hash TEXT NOT NULL,
  created TIMESTAMPTZ DEFAULT NOW(),
  confirmed BOOLEAN DEFAULT FALSE,
  totp_secret TEXT,
  totp_on BOOLEAN DEFAULT FALSE
);
```

Пароли хранятся только как scrypt-хеш с индивидуальной солью — в открытом виде
ничего нет.
