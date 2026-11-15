# Llaves de desarrollo

Estas llaves solo existen para que `docker compose up` funcione sin pasos escondidos. **No las usen fuera de su máquina.**

- `usuarios-ed25519.pem` es la llave **privada**. Solo se monta en el contenedor `usuarios`, que es el único que firma tokens.
- `usuarios-ed25519.pub.pem` es la llave **pública**. Se monta en el monolito, que con ella verifica los tokens localmente pero no puede fabricarlos.

Para generar unas nuevas:

```sh
openssl genpkey -algorithm ed25519 -out usuarios-ed25519.pem
openssl pkey -in usuarios-ed25519.pem -pubout -out usuarios-ed25519.pub.pem
```

En producción, la llave privada vendría de un gestor de secretos y nunca estaría en el repositorio.
