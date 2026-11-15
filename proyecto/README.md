# ACME - Rastreo y entrega de paquetes

Segunda etapa (`02-usuarios`) del sistema descrito en [el PRD](docs/PRD.md). **Usuarios** ya es un servicio aparte, con tres réplicas de PostgreSQL y escrituras por quórum. El **monolito** conserva Movimientos, Reintentos y Consulta: verifica los tokens por su cuenta y se entera de las sesiones cerradas por eventos de RabbitMQ. **Nginx** es la única puerta de entrada.
Equipo: **ACME** - Integrantes: **@onofrela, @Ur182, @grecia-i y @brannvic**.

```text
cliente ──► nginx :8080 ──┬─► usuarios ──► usuarios-db-1 / -2 / -3   (quórum: W=2, R=2)
                          │      │
                          │      └─► rabbitmq ── sesion_terminada ──┐
                          └─► app (monolito) ◄──────────────────────┘
                                 └─► db (paquetes, movimientos, reintentos)
```

## Levantar con Docker

Se necesita Docker Desktop encendido, con contenedores Linux y Docker Compose. Las imágenes compilan TypeScript, así que no hace falta instalar Node para levantar el sistema.

```sh
docker compose up --build -d --wait
docker compose ps
docker compose exec usuarios npm run seed:prod
docker compose exec app npm run demo
```

La API escucha en `http://localhost:8080`, que es Nginx: ningún otro contenedor publica puertos. Para comprobar que todo está arriba:

- `GET /health` responde `{"estado":"UP","baseDatos":"UP","mensajeria":"UP"}` (monolito, su base y RabbitMQ).
- `GET /health/usuarios` muestra el estado de las 3 réplicas y si hay quórum.

El primer arranque descarga imágenes y dependencias, y RabbitMQ tarda unos 20 s en estar listo. Si algo falla, `docker compose logs nginx usuarios app` dice dónde.

Compose usa valores locales de desarrollo. Se puede copiar `.env.example` a `.env` y cambiar puerto, contraseñas de las bases y de RabbitMQ, y la contraseña de demostración antes del primer arranque. Los tokens se firman con las llaves de [`claves-desarrollo/`](claves-desarrollo/README.md); ahí se explica cómo generar unas propias. El `seed` escribe por quórum: crea las cuentas que falten y conserva las existentes, sin cambiar sus contraseñas.

| Rol | Correo | Contraseña inicial por defecto |
|---|---|---|
| Administrador | `administrador@acme.test` | `AcmeDemo2026!` |
| Cliente | `cliente@acme.test` | `AcmeDemo2026!` |
| Almacenista | `almacenista@acme.test` | `AcmeDemo2026!` |
| Repartidor | `repartidor@acme.test` | `AcmeDemo2026!` |

Para detener conservando los datos:

```sh
docker compose down
```

Los volúmenes `acme_datos`, `usuarios_datos_1..3` y `rabbitmq_datos` conservan los datos. No usen `down -v` si quieren preservar paquetes y cuentas.

**Si vienen de `01-monolito` con datos guardados:** la migración nueva saca las tablas `usuarios` y `sesiones` de la base del monolito, porque ahora viven en el servicio Usuarios. Los paquetes conservan su historial, pero su `clienteId` apunta a cuentas que ya no existen. Para la demo conviene empezar de cero una sola vez, con `docker compose down -v`.

## Recorrido y endpoints

`npm run demo` hace todo esto y sale con código distinto de cero si algo falla:

1. Revisa la salud de los dos servicios e inicia sesión con los cuatro roles.
2. Crea una guía, corrige la dirección y registra almacén, centro, salida a ruta y entrega con receptor.
3. Verifica reenvíos sin duplicados y el rechazo de una corrección fuera de ventana.
4. Comprueba que Nginx no publica las rutas internas.
5. Cierra las sesiones y mide cuánto tarda la revocación en llegar al monolito por evento (unos milisegundos).

Se puede repetir: genera una guía distinta cada vez.

Todos los endpoints de negocio empiezan con `/api/v1`. Envía JSON y, para las rutas protegidas, `Authorization: Bearer <token>`.

| Método y ruta | Servicio | Operación y acceso |
|---|---|---|
| `POST /auth/login` | Usuarios | `{correo, contrasena}` → `{token, venceEn, usuario}` |
| `POST /auth/logout` | Usuarios | Revoca la sesión del token actual |
| `POST /auth/contrasena` | Usuarios | `{contrasenaActual, contrasenaNueva}` (mínimo 12). Revoca todas las sesiones de la cuenta |
| `POST /paquetes` | Monolito | Administrador: `{numeroGuia, clienteId, destinatario, direccion}` |
| `POST /movimientos/escanear` | Monolito | Almacenista o repartidor: `{id, numeroGuia, tipo, ubicacion?, motivo?, receptor?}` |
| `GET /tracking/:numero_guia` | Monolito | Público: guía, estado y línea de tiempo sin datos personales |
| `GET /tracking/:numero_guia/detalle` | Monolito | Cliente titular: datos completos e historial |
| `PATCH /movimientos/:numero_guia/direccion` | Monolito | Cliente titular: `{id, direccion}` |
| `GET /reintentos` | Monolito | Repartidor o administrador: programación pendiente |
| `PATCH /paquetes/:numero_guia/caso` | Monolito | Administrador: `{clienteRespondio, notasContacto, decisionProveedor?}` |

Usuarios también tiene rutas **internas**, que Nginx no publica y solo usa el monolito dentro de la red de Docker:

- `GET /interno/sesiones/:id`: ¿la sesión sigue activa?
- `GET /interno/usuarios/:id`: ¿existe el usuario y qué rol tiene?

La creación del envío representa una orden ya confirmada por el proveedor. El `clienteId` se obtiene de la respuesta de login del cliente; el monolito le pregunta a Usuarios si ese cliente existe. La guía debe tener entre 6 y 40 caracteres: letras mayúsculas, números y guiones. `id` es un UUID que genera quien llama y que se conserva al reintentar.

Ejemplo de login:

```sh
curl -i http://localhost:8080/api/v1/auth/login -H "Content-Type: application/json" --data '{"correo":"cliente@acme.test","contrasena":"AcmeDemo2026!"}'
```

En Windows PowerShell hay que usar `curl.exe`, o correr la demostración con Docker para evitar las diferencias de comillas entre shells.

### Flujo permitido

```text
creado → en_almacen → en_centro_distribucion → en_ruta ──► entregado
                                                │   └──► entrega_por_confirmar ──► entregado
                                                ↓         (Usuarios no respondió)   └─► en_ruta si la sesión estaba revocada
                                          intento_fallido
                                                ↓
                                   siguiente día, distinta franja
                                                ↓
                                             en_ruta
                                                ↓
                              tercer intento fallido → en_sucursal
```

El almacenista registra `ingreso_almacen` e `ingreso_centro_distribucion`, con `ubicacion` obligatoria. Puede registrar varias paradas dentro de la misma categoría. El repartidor registra `salida_ruta`, `intento_fallido` con `motivo`, y `entregado` con `receptor`.

La primera salida se puede registrar a cualquier hora: antes de las 14:00 cuenta como mañana y desde las 14:00 como tarde. Los **reintentos** sí deben salir en su franja, hora de Ciudad de México:

- mañana: `[09:00, 13:00)`
- tarde: `[14:00, 18:00)`

Se admite un reintento por día. Si no se hace el día programado, sigue pendiente y puede salir otro día posterior en la misma franja. Los intentos no se gastan solo porque pase el tiempo. Tras tres intentos fallidos en días distintos, el sistema registra automáticamente el paso a sucursal.

La programación se crea junto con el fallo y se consume con la siguiente salida; no hay un proceso que simule visitas. La dirección queda bloqueada desde la primera salida a ruta, incluso después de un intento fallido. Elegimos esta lectura estricta del PRD, así que no hay reintentos previos a una corrección aceptada.

En sucursal se registra el contacto con el cliente:

- **Si el cliente no respondió**, el administrador puede registrar `decisionProveedor: "regresar"` o `"no_regresar"` y cerrar el caso, en la misma petición o en otra. Las dos opciones requieren notas.
- **Si el cliente respondió**, queda registrado el contacto y el caso sigue abierto.

En ambos casos el estado se queda en `en_sucursal`: el sistema no ejecuta devoluciones.

### Respuestas y consistencia

- **Códigos de éxito:**
  - `201`: alta de envío, o movimiento o corrección registrados.
  - `202`: registrado, pero **pendiente de confirmación**. Pasa en "entregado" y en corrección de dirección cuando Usuarios no pudo confirmar que la sesión sigue activa.
  - `200`: reenvío idéntico del mismo UUID.

  La respuesta de movimiento es `{movimiento, duplicado}`, y `movimiento.confirmacion` vale `confirmada`, `pendiente` o `rechazada`. Reutilizar un UUID con otros datos devuelve `409`.
- **Códigos de error:**
  - `400`: datos inválidos.
  - `401`: token ausente, inválido, vencido o revocado.
  - `403`: rol o titular incorrecto.
  - `404`: guía inexistente.
  - `409`: transición incompatible o conflicto concurrente. Esto incluye intentar otro movimiento mientras hay una entrega por confirmar.
  - `503`: una base, Usuarios o el quórum no están disponibles.
- **Transacciones:** el paquete se bloquea mientras se modifica. Historial, estado, intento y programación se confirman juntos o se revierten juntos. Las consultas leen una versión consistente y ordenan el historial por secuencia de inserción.
- **Tokens:** Usuarios los firma con una llave privada Ed25519 y duran 12 horas, una jornada completa. El monolito solo tiene la llave pública: comprueba firma y vencimiento **sin consultar a nadie**. La revocación la revisa en su propia tabla `sesiones_revocadas`.
- **Revocación por eventos:** el logout y el cambio de contraseña marcan la sesión como revocada con `evento_publicado = false`, en la misma escritura por quórum. Así, la tabla de sesiones funciona como **outbox**. Un publicador manda `sesion_terminada` a RabbitMQ (exchange `acme.eventos`) con confirmación del broker y solo entonces marca el evento como publicado. El monolito lo consume de forma idempotente y solo da el `ack` después de guardarlo.
- **Revocación síncrona:** "entregado" y la corrección de dirección le preguntan además a Usuarios, con un timeout de 2 s.
  - Si la sesión está revocada, responde `401` al momento.
  - Si Usuarios no contesta, el movimiento queda `pendiente` y no es terminal. Cada 15 s (`RECONCILIAR_CADA_MS`), el monolito vuelve a preguntar.
  - Cuando Usuarios confirma la sesión, la entrega pasa a `entregado` o se aplica la dirección. Si la sesión estaba revocada, se rechaza y el paquete regresa a `en_ruta`. La corrección también se rechaza si el paquete salió a ruta mientras esperaba.
- **Quórum en Usuarios:** cada escritura se manda a las 3 réplicas y se confirma con 2 acuses (W=2). Cada lectura espera 2 respuestas y se queda con la `version` más alta (R=2); de paso, repara las réplicas atrasadas. Como R + W > N, **una contraseña vieja nunca gana**. Sin mayoría no hay login, logout, registro ni cambio de contraseña (`503`), pero los tokens vigentes siguen funcionando.
- **Hora:** sale del servidor. Todavía no hay funcionamiento sin conexión; eso llega con la PWA.

## Qué pasa cuando algo falla

Todo esto se probó tirando cada pieza a propósito; los casos principales también están en las pruebas de integración.

| Falla | Qué pasa |
|---|---|
| Cae 1 réplica de Usuarios | Todo sigue funcionando; `/health/usuarios` dice `DEGRADADO`. Al volver, las lecturas la ponen al día |
| Caen 2 réplicas de Usuarios | Login y logout responden `503`. Con su token vigente, el repartidor sigue escaneando. Un "entregado" queda `202`/`entrega_por_confirmar` y se confirma solo cuando vuelven las réplicas |
| Cae el servicio Usuarios | Nginx responde `503` en `/auth/*`. El monolito sigue atendiendo con los tokens vigentes. Dar de alta un envío responde `503`, porque no se puede validar al titular |
| Cae RabbitMQ | El logout funciona igual: el evento espera en el outbox de Usuarios. Las operaciones normales aceptan ese token hasta que llegue el evento, pero las sensibles lo rechazan al momento porque le preguntan a Usuarios. Al volver RabbitMQ, la revocación llega en un par de segundos |
| Cae el monolito durante un logout | El evento espera en la cola durable `monolito.sesion_terminada`. Al reiniciar, el monolito vacía esa cola **antes** de abrir su API |
| Cae la base del monolito | Esa parte responde `503` sin exponer errores internos. Usuarios sigue funcionando |

## Pruebas

Las pruebas corren fuera de Docker, así que aquí sí se necesita Node.js 22 o superior. `docker-compose.test.yml` levanta infraestructura exclusiva para pruebas, que no toca los volúmenes del sistema:

- la base del monolito en `55432`;
- las 3 réplicas de Usuarios en `55441`–`55443`;
- RabbitMQ en `55672`.

No hace falta `.env`: cada prueba genera sus propias llaves y controla su propio reloj.

```sh
docker compose -f docker-compose.test.yml up -d --wait

npm ci
npm test                    # reglas puras: fechas en Ciudad de México y franjas
npm run test:integration    # monolito contra PostgreSQL y RabbitMQ reales (detalle abajo)

cd usuarios && npm ci
npm test                    # tokens Ed25519, contraseñas, mayoría y versiones
npm run test:integration    # 3 PostgreSQL y RabbitMQ reales (detalle abajo)
cd ..

docker compose -f docker-compose.test.yml down
```

Qué revisa cada prueba de integración:

- **Monolito:** permisos, idempotencia, concurrencia, rollback, los tres días de reintentos, el "entregado" pendiente que se confirma o se rechaza, la revocación por evento y el `503` sin base.
- **Usuarios:** login, rutas internas, el logout que publica `sesion_terminada`, una réplica caída (sigue funcionando), dos caídas (`503`) y que la contraseña vieja nunca gana.

Cada prueba de integración levanta su propia instancia en un puerto libre; no hace falta que `docker compose up` esté corriendo. En la del monolito, la propia prueba hace de Usuarios: firma tokens con una llave generada en el momento y simula que Usuarios responde o se cae. Para apuntar a otra infraestructura existen `TEST_DB_*`, `TEST_USUARIOS_DB_URLS` y `TEST_RABBITMQ_URL`. Por seguridad, las bases deben llamarse `acme_test…` y `usuarios_test`.

Para recorrer la API a mano, importen las colecciones de [`postman/`](postman/README.md) con el sistema levantado y los usuarios de demostración creados.

## Cómo leer el código

| Dónde | Qué hay |
|---|---|
| `nginx/nginx.conf` | Las rutas que se publican y a qué servicio va cada una |
| `usuarios/src/quorum.ts` | El quórum: escritura W=2, lectura R=2, versiones y reparación de réplicas atrasadas |
| `usuarios/src/usuarios.service.ts` | Login, logout, cambio de contraseña y sesiones |
| `usuarios/src/publicador-sesiones.ts` | El outbox de sesiones hacia RabbitMQ |
| `usuarios/src/tokens.ts` y `src/autenticacion/tokens.ts` | Firma (Usuarios) y verificación local (monolito) de los tokens |
| `src/autenticacion/` | El guard que verifica tokens sin red, el consumidor de `sesion_terminada` y el cliente HTTP hacia Usuarios, siempre con timeout |
| `src/movimientos/movimientos.service.ts` | `registrarMovimiento` muestra el recorrido completo de una escritura, incluida la revocación síncrona |
| `src/movimientos/confirmaciones.service.ts` | El reconciliador de movimientos pendientes y su compensación |
| `src/reintentos/` | Registra intentos y programa la siguiente visita dentro de la transacción que recibe de Movimientos |
| `src/consulta/` | Dos vistas: la pública y la privada del titular |

El monolito usa TypeORM con migraciones; `synchronize` está desactivado y Docker aplica las migraciones antes de arrancar. Usuarios usa `pg` directo, porque el quórum necesita hablar con cada réplica por separado. Su esquema se crea en cada réplica la primera vez que esta responde, aunque haya estado caída al arrancar.

## Arquitectura para la defensa

| Pregunta | Respuesta en `02-usuarios` |
|---|---|
| ¿Dónde está la entrada/gateway? | Nginx, el único contenedor con puerto publicado (8080). Manda `/api/v1/auth/*` a Usuarios y el resto de `/api/v1/*` al monolito; no publica `/interno/*`. El gateway con 3 copias llega en `04-consulta` |
| ¿Dónde está el directorio? | El DNS interno de Docker Compose. Nginx vuelve a resolver los nombres cada 10 s (`resolver 127.0.0.11`), así que un contenedor reiniciado se vuelve a encontrar aunque cambie de IP |
| ¿Cómo se balancea? | Todavía hay una copia de cada servicio. El quórum reparte lecturas y escrituras de Usuarios entre 3 réplicas |
| ¿Dónde están los datos? | **Usuarios:** 3 PostgreSQL independientes, una por "región", con quórum. **Monolito:** su propia PostgreSQL, sin llaves foráneas hacia Usuarios. Las redes de Compose (`datos-usuarios`, `datos-monolito`) impiden que un servicio llegue a la base del otro |
| ¿Cómo se comunican las partes? | Asíncrono: `sesion_terminada` por RabbitMQ con outbox. Síncrono: HTTP interno con timeout de 2 s, para validar al titular de un envío y revisar la sesión en operaciones sensibles. Los tokens se verifican localmente, sin red |
| ¿Qué pasa si algo falla? | Ver [Qué pasa cuando algo falla](#qué-pasa-cuando-algo-falla). En resumen: Usuarios prefiere negar el servicio a abrir una brecha, el monolito prefiere seguir atendiendo y marca como pendiente lo que no pudo verificar, y ningún evento se pierde |
| Limitaciones declaradas | Si una escritura llega a una sola réplica, falla con `503`, pero esa réplica guarda el valor y la siguiente lectura puede adoptarlo. Las rutas `/interno` solo se protegen por la red; en producción llevarían mTLS. Hay un solo Nginx |
