interface ProductCardProps {
  product: {
    id: number;
    category: string | undefined;
    name: string;
    price_inr: string;
    available: boolean;
    dietary_classification: string;
    ingredients: string[];
  };
}

export function ProductCard({ product }: ProductCardProps) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-brown-200 bg-white p-3 mb-2">
      <div className="w-9 h-9 rounded-full bg-brown-100 flex items-center justify-center text-brown-700 font-semibold text-xs">
        {String(product.name).charAt(0).toUpperCase()}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <h4 className="font-medium text-brown-800 text-sm">{product.name}</h4>
          <span className="text-brown-500 font-medium">{product.price_inr}</span>
        </div>
        <p className="text-xs text-brown-500 truncate">
          {product.category} · {product.dietary_classification}
        </p>
        {!product.available && (
          <span className="text-[10px] uppercase tracking-wider font-bold text-brown-500 bg-brown-50 px-2 py-0.5 rounded">
            unavailable
          </span>
        )}
      </div>
    </div>
  );
}
