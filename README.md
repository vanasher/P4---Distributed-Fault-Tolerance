# P4 – Distributed Fault-Tolerant Enrollment System

An online enrollment system split across six nodes. The view node is an Express MVC web app; every feature lives on its own service node, and nodes talk to each other only over gRPC.

| Node | File | Default address | Features |
|---|---|---|---|
| View (MVC) | `view/app.js` | https://localhost:3000 | Web pages; calls the services over gRPC |
| Auth | `services/auth.js` | localhost:50051 | Login / logout, issues JWTs, tracks sessions |
| Course | `services/course.js` | localhost:50052 | View courses, enroll in open courses |
| Grade | `services/grade.js` | localhost:50053 | View previous grades, faculty upload grades |
| Announcement *(bonus)* | `services/announcement.js` | localhost:50054 | Faculty post announcements, everyone reads them |
| Schedule *(bonus)* | `services/schedule.js` | localhost:50055 | Class timetable; calls the course node over gRPC to find a student's classes |

The gRPC contract for all five services is in `proto/enrollment.proto`.

**Database (bonus: connection pooling).** Data lives in PostgreSQL. This follows the database-per-service pattern: one server, and each service owns its own database (`auth`, `course`, `grade`, `announcement`, `schedule`). No service reads another's tables. Each service creates its database on first start and talks to it through its own `pg.Pool`.

| Pool setting | Value | Why |
|---|---|---|
| `max` | 10, set by `DB_POOL_MAX` | At most 10 connections per service. Up to 10 are opened as load needs them and then reused, so a request doesn't pay a new TCP and login handshake. |
| `idleTimeoutMillis` | 30000 | Closes connections that have been idle for 30 seconds. |
| `connectionTimeoutMillis` | 1000 | If the database is down, a request fails within 1 second, inside the view's 2-second deadline. |

Each service's log shows the pool after every call, for example `[pool: 1 open, 1 idle, 0 waiting]`.

## Build

Requires Node.js 22 and PostgreSQL. The easiest way to get PostgreSQL is Docker:

```
npm install
docker compose up -d db     # PostgreSQL on localhost:5433 (user p4, password p4)
```

There's no compile step. The proto file is loaded at runtime.

## Run (one machine)

Start PostgreSQL first (`docker compose up -d db`). Then open six terminals in this folder and run one node in each:

```
npm run auth
npm run course
npm run grade
npm run announcement
npm run schedule
npm run view
```

Then open https://localhost:3000. The demo accounts are `student1`, `student2` and `faculty1`, all with password `password`.

To reset the data, run `docker compose down -v`. This deletes the PostgreSQL volume.

### HTTPS certificate

The view node serves HTTPS only. The first time it starts, it creates a self-signed certificate in `certs/`. With that certificate the browser shows a warning; click **Advanced → Proceed** once.

To get no warning at all, install `mkcert` (`scoop install mkcert`). Then run this from the repo folder before starting the view:

```
mkcert -install
mkcert -cert-file certs/cert.pem -key-file certs/key.pem localhost 127.0.0.1 <this machine's LAN IP>
```

Internal gRPC traffic between the nodes is plaintext.

## Run (Docker, each node in its own container)

This needs Docker Desktop to be running. Each node runs in its own container with its own network stack. The networking is configured explicitly in `docker-compose.yml`: a bridge network `p4-net` on subnet `172.28.0.0/24`, with a static IP for each node. The view reaches the services over gRPC at those IPs.

| Container | IP | Port |
|---|---|---|
| p4-view | 172.28.0.10 | 3000, the only port published to the host |
| p4-auth | 172.28.0.11 | 50051 |
| p4-course | 172.28.0.12 | 50052 |
| p4-grade | 172.28.0.13 | 50053 |
| p4-announcement | 172.28.0.14 | 50054 |
| p4-schedule | 172.28.0.15 | 50055 |
| p4-db (PostgreSQL) | 172.28.0.20 | 5432 inside the network, published to the host as **5433** (so it never clashes with a locally installed PostgreSQL) |

```
docker compose up --build -d     # build the image and start all 6 nodes plus PostgreSQL
docker compose ps                # list the 7 containers
docker compose logs -f grade     # follow one node's gRPC log
```

Open https://localhost:3000. To demo fault tolerance:

```
docker stop p4-grade     # grade node down: the grades page says so, everything else still works
docker start p4-grade    # back within about 2 seconds, with no data lost
docker stop p4-db        # database down: data pages say "The database is unavailable right now." and the site stays up
docker start p4-db       # the pools reconnect on their own
```

To stop everything, run `docker compose down`. Adding `-v` also wipes the database. PostgreSQL keeps its data in the `pg-data` volume. The view reuses the certificate in `certs/`, so an mkcert certificate works here too.

## Run (separate machines / VMs)

Copy the repo and run `npm install` on each machine. Then set the addresses and the shared JWT secret on every node:

```
# PowerShell
$env:AUTH_ADDR="192.168.1.11:50051"; $env:COURSE_ADDR="192.168.1.12:50052"; $env:GRADE_ADDR="192.168.1.13:50053"
$env:ANNOUNCEMENT_ADDR="192.168.1.14:50054"; $env:SCHEDULE_ADDR="192.168.1.15:50055"
$env:JWT_SECRET="same-secret-on-every-node"
$env:PGHOST="192.168.1.20"   # the PostgreSQL machine (service nodes only)
npm run view   # or auth / course / grade / announcement / schedule
```

The view and the schedule node need the addresses (schedule only needs `COURSE_ADDR`). Service nodes listen on `0.0.0.0` at the port from their own address. Open those ports in the firewall.

## Test

```
npm test
```

This needs PostgreSQL running (`docker compose up -d db`). It starts all six nodes on spare ports against throwaway `test_*` databases, so your real data is never touched. It then runs the following checks:
- login, enrollment, capacity, grade viewing and uploading, announcements, schedule
- 8 simultaneous enroll requests for the same seat, of which exactly 1 succeeds
- input validation edge cases (bad CSV lines, duplicates, oversized posts, missing fields)
- killing each service node in turn, to confirm the rest of the app keeps working
- restarting a node, to confirm the app picks it back up

## How fault tolerance works

- **Separate nodes, separate data.** Each feature runs in its own process with its own database, so a crash only takes out that one feature.
- **Database outages are contained.** If PostgreSQL is unreachable, the pool fails the request within 1 second, and the service answers `UNAVAILABLE` with "The database is unavailable right now." The view stays up and shows that message. When the database comes back, the pools reconnect without restarting anything. The shared database server is still a single point of failure; the redundant-database bonus removes it.
- **Fail fast, degrade locally.** The view node gives every gRPC call a 2-second deadline. When a node is down, its call fails with `UNAVAILABLE`, and only that page shows "the X service is down". The other pages keep working.
- **Sessions survive the auth node going down.** Login returns a signed JWT that the view stores in a cookie and forwards with every gRPC call. Every service checks the signature itself with the shared secret, so it doesn't need to ask the auth node. Users who are already logged in keep using courses and grades while auth is down; only new logins fail.
- **Automatic recovery.** The gRPC clients reconnect with a short backoff, capped at 2 seconds, so a restarted node is picked up without restarting the view. The data persists in PostgreSQL, so nothing is lost across a restart.
- **No overbooking.** Enrollment runs in a transaction that locks the course row (`SELECT ... FOR UPDATE`). Concurrent enrollments for one course take turns, so two students can never both take the last seat.
- **Graceful degradation between nodes.** The schedule node depends on the course node to know which classes a student is in. If the course node is down, the schedule node doesn't fail. It shows every class with a note saying enrollments couldn't be loaded. Its call to the course node uses a 1-second deadline, so it answers before the view's 2-second deadline runs out.
