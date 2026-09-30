# Laboratorio 07: LOGIN + CRUD con balanceo de carga

**Estudiante:** Ortiz

Aplicación Express con PostgreSQL 17 para usuarios, productos y sesiones. El despliegue AWS usa la VPC predeterminada en `us-east-1`, dos subredes públicas en zonas distintas, dos EC2 de aplicación, una EC2 de base de datos y un ALB HTTP.

```text
Navegador → ALB :80 → Target Group :3000 → app-aws-1 / app-aws-2
                                              ↘ PostgreSQL 17 :5432
```

Las dos aplicaciones comparten PostgreSQL y `SESSION_SECRET`; la persistencia de PostgreSQL usa un volumen Docker. Los grupos de seguridad permiten HTTP y SSH solo desde la IP pública `/32` usada durante el despliegue, el puerto 3000 solo desde el SG del ALB y el 5432 solo desde el SG de las aplicaciones. Los tres EC2 son `t3.micro` On-Demand, con raíz gp3 de 8 GiB y créditos CPU en modo standard. Estos recursos pueden generar cargos.

## Estado comprobado

- ALB: `http://lab07-alb-644962620.us-east-1.elb.amazonaws.com`
- Ambos targets alcanzaron el estado `healthy` con `/health` HTTP 200.
- `/products` sin sesión llevó al formulario de login.
- El usuario `ortiz` inició sesión con CSRF y cookie; la misma sesión recibió respuestas de `app-aws-1` y `app-aws-2`.
- Se creó, consultó, editó y eliminó un producto ficticio, comprobando los cambios por el ALB.
- La prueba de caída y recuperación está **pendiente**: SSH al primer servidor agotó el tiempo antes de detener el contenedor. No se interrumpió ninguna aplicación durante esa prueba.

El ALB usa HTTP de forma temporal para datos ficticios y una contraseña exclusiva del laboratorio. PostgreSQL es un punto único de fallo. El acceso está limitado a la IP `/32` del despliegue; si cambia la red de salida, la URL puede dejar de ser accesible hasta actualizar esas reglas.

## Operación

- Despliegue reproducible: `python3 infra/aws/deploy.py`
- Verificación web: `python3 infra/aws/verify.py`
- Prueba de caída y recuperación pendiente: `python3 infra/aws/failover.py`
- Limpieza, **después de tomar las capturas**: `python3 infra/aws/cleanup.py`

El inventario, los identificadores de VPC, subredes y AMI, la clave SSH y los secretos se guardan en `.local/aws/`, que Git ignora. La configuración privada de despliegue es `.local/aws/settings.json` y la ruta de credenciales es `.local/aws/credentials.env`; su contenido no se publica. La limpieza elimina solo recursos del inventario con etiquetas `Project=lab07-disenio-entorno` y `ManagedBy=codex`; no modifica la VPC ni las subredes.

Las capturas solicitadas y sus pendientes se enumeran en [evidencias/README.md](evidencias/README.md).
