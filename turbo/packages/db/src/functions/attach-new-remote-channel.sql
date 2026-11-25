-- Old writers can omit remote_device_id. Run only after a successful insert,
-- so an installation upsert never allocates a device for its losing row.
CREATE FUNCTION public.attach_new_remote_channel() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  device_id uuid;
BEGIN
  INSERT INTO public.remote_devices (org_id, user_id, display_name)
  VALUES (NEW.org_id, NEW.user_id, NEW.display_name)
  RETURNING id INTO device_id;

  EXECUTE format(
    'UPDATE %I.%I SET remote_device_id = $1 WHERE id = $2',
    TG_TABLE_SCHEMA,
    TG_TABLE_NAME
  ) USING device_id, NEW.id;

  RETURN NULL;
END;
$$;

CREATE TRIGGER attach_new_remote_channel
AFTER INSERT ON public.computer_use_hosts
FOR EACH ROW WHEN (NEW.remote_device_id IS NULL)
EXECUTE FUNCTION public.attach_new_remote_channel();

CREATE TRIGGER attach_new_remote_channel
AFTER INSERT ON public.phone_use_devices
FOR EACH ROW WHEN (NEW.remote_device_id IS NULL)
EXECUTE FUNCTION public.attach_new_remote_channel();

CREATE TRIGGER attach_new_remote_channel
AFTER INSERT ON public.ssh_connections
FOR EACH ROW WHEN (NEW.remote_device_id IS NULL)
EXECUTE FUNCTION public.attach_new_remote_channel();

CREATE TRIGGER attach_new_remote_channel
AFTER INSERT ON public.vnc_connections
FOR EACH ROW WHEN (NEW.remote_device_id IS NULL)
EXECUTE FUNCTION public.attach_new_remote_channel();
