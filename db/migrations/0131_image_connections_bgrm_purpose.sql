alter table image_connections
  drop constraint if exists image_connections_purpose_check;

alter table image_connections
  add constraint image_connections_purpose_check
  check (purpose in ('background', 'portrait', 'bgrm'));

alter table image_connections
  add constraint image_connections_bgrm_runware_only
  check (purpose <> 'bgrm' or kind = 'runware');
