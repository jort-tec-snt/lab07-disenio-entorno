# Capturas finales pendientes

No se han añadido imágenes. Antes de ejecutar la limpieza, tomar capturas de:

1. Formulario de login del ALB.
2. CRUD: producto de prueba creado, editado y eliminado.
3. Las dos EC2 de aplicación y la EC2 de base de datos.
4. ALB y listener HTTP:80.
5. Ambos targets `healthy` en el Target Group.
6. Fallo: un target `unhealthy` tras detener solo su contenedor de aplicación.
7. Recuperación: ambos targets `healthy` tras restaurar el contenedor.

Las capturas 6 y 7 requieren ejecutar `python3 infra/aws/failover.py` cuando SSH esté disponible. Esa prueba quedó pendiente porque la conexión SSH agotó el tiempo antes de detener la aplicación. No mostrar credenciales, cookies, identificadores de cuenta ni la IP personal en las capturas públicas.
