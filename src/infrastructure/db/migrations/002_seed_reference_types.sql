INSERT INTO reference_types (code, name)
VALUES
  ('brand', 'Бренд'),
  ('category', 'Категория'),
  ('gender', 'Пол'),
  ('condition', 'Состояние товара'),
  ('box_condition', 'Состояние коробки'),
  ('size_system', 'Система размеров'),
  ('color', 'Цвет')
ON CONFLICT (code) DO UPDATE
SET name = EXCLUDED.name,
    updated_at = NOW();
