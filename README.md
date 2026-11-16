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
