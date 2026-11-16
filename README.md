# P4 – Distributed Fault-Tolerant Enrollment System

An online enrollment system split across four nodes. The view node is an Express MVC web app; every feature lives on its own service node, and nodes talk to each other only over gRPC.

| Node | File | Default address | Features |
|---|---|---|---|
| View (MVC) | `view/app.js` | https://localhost:3000 | Web pages; calls the services over gRPC |
| Auth | `services/auth.js` | localhost:50051 | Login / logout, issues JWTs, tracks sessions |
| Course | `services/course.js` | localhost:50052 | View courses, enroll in open courses |
| Grade | `services/grade.js` | localhost:50053 | View previous grades, faculty upload grades |

The gRPC contract for all three services is in `proto/enrollment.proto`. Each service node keeps its own SQLite database in `data/`.

## Build

Requires Node.js 22.13 or newer (it uses the built-in `node:sqlite`).

```
npm install
```

There's no compile step. The proto file is loaded at runtime.

## Run (one machine)

Open four terminals in this folder and run one node in each:

```
npm run auth
npm run course
npm run grade
npm run view
```

Then open https://localhost:3000. The demo accounts are `student1`, `student2` and `faculty1`, all with password `password`.

To reset the data, stop everything and delete the `data/` folder.

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

```
docker compose up --build -d     # build the image and start all 4 nodes
docker compose ps                # list the containers: p4-auth, p4-course, p4-grade, p4-view
docker compose logs -f grade     # follow one node's gRPC log
```

Open https://localhost:3000. To demo fault tolerance:

```
docker stop p4-grade     # grade node down: the grades page says so, everything else still works
docker start p4-grade    # back within about 2 seconds, with no data lost
```

To stop everything, run `docker compose down`. Adding `-v` also wipes the databases. Each service keeps its data in its own Docker volume. The view reuses the certificate in `certs/`, so an mkcert certificate works here too.

## Run (separate machines / VMs)

Copy the repo and run `npm install` on each machine. Then set the addresses and the shared JWT secret on every node:

```
# PowerShell
$env:AUTH_ADDR="192.168.1.11:50051"; $env:COURSE_ADDR="192.168.1.12:50052"; $env:GRADE_ADDR="192.168.1.13:50053"
$env:JWT_SECRET="same-secret-on-every-node"
npm run view   # or auth / course / grade
```

Service nodes listen on `0.0.0.0` at the port from their own address. Open those ports in the firewall.

## Test

```
npm test
```

This starts all four nodes on spare ports with a throwaway database. It then runs the following checks:
- login, enrollment, capacity, grade viewing and uploading
- killing each service node in turn, to confirm the rest of the app keeps working
- restarting a node, to confirm the app picks it back up

## How fault tolerance works

- **Separate nodes, separate data.** Each feature runs in its own process with its own database, so a crash only takes out that one feature.
- **Fail fast, degrade locally.** The view node gives every gRPC call a 2-second deadline. When a node is down, its call fails with `UNAVAILABLE`, and only that page shows "the X service is down". The other pages keep working.
- **Sessions survive the auth node going down.** Login returns a signed JWT that the view stores in a cookie and forwards with every gRPC call. Every service checks the signature itself with the shared secret, so it doesn't need to ask the auth node. Users who are already logged in keep using courses and grades while auth is down; only new logins fail.
- **Automatic recovery.** The gRPC clients reconnect with a short backoff, capped at 2 seconds, so a restarted node is picked up without restarting the view. The data persists in SQLite, so nothing is lost across a restart.
