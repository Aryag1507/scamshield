"""Weight-only int8 quantization for CPU serving.

Earlier attempt: torch's dynamic int8 quantized activations too, and accuracy collapsed (36%
vs 83%): small Qwen models have a few huge-magnitude activation channels that per-tensor int8
can't represent. Weight-only int8 sidesteps that: weights are stored as int8 with one fp32
scale per output channel, activations stay fp32, and the fused CPU kernel
(aten._weight_int8pack_mm) dequantizes inside the matmul, so memory traffic per decode step
drops ~4x.

The input embedding and the LM head share one weight matrix in Qwen2.5-0.5B (tied), so both
are backed by the same int8 tensor and scales.
"""

import torch
from torch import nn


def quantize_rows(w: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
    """Symmetric per-row int8: w ≈ q * scale[:, None]."""
    w = w.detach().float()
    scale = (w.abs().amax(dim=1) / 127).clamp(min=1e-8)
    q = torch.round(w / scale[:, None]).clamp(-127, 127).to(torch.int8)
    return q.contiguous(), scale.contiguous()


class Int8Linear(nn.Module):
    def __init__(self, q: torch.Tensor, scale: torch.Tensor, bias: torch.Tensor | None):
        super().__init__()
        self.register_buffer("q", q)
        self.register_buffer("scale", scale)
        self.register_buffer("bias", None if bias is None else bias.detach().float())
        self.in_features, self.out_features = q.shape[1], q.shape[0]

    @classmethod
    def from_linear(cls, linear: nn.Linear) -> "Int8Linear":
        q, scale = quantize_rows(linear.weight)
        return cls(q, scale, linear.bias)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        shape = x.shape
        y = torch.ops.aten._weight_int8pack_mm(x.reshape(-1, shape[-1]).float().contiguous(), self.q, self.scale)
        if self.bias is not None:
            y = y + self.bias
        return y.reshape(*shape[:-1], self.out_features)


class Int8Embedding(nn.Module):
    def __init__(self, q: torch.Tensor, scale: torch.Tensor, padding_idx: int | None):
        super().__init__()
        self.register_buffer("q", q)
        self.register_buffer("scale", scale)
        self.padding_idx = padding_idx

    def forward(self, ids: torch.Tensor) -> torch.Tensor:
        return self.q[ids].float() * self.scale[ids].unsqueeze(-1)


@torch.no_grad()
def quantize_model_int8(model: nn.Module) -> dict:
    """In place: every nn.Linear -> Int8Linear; a tied embedding/LM head share one int8 matrix."""
    before = sum(t.numel() * t.element_size() for t in list(model.parameters()) + list(model.buffers()))
    tied = model.get_output_embeddings() is not None and \
        model.get_output_embeddings().weight.data_ptr() == model.get_input_embeddings().weight.data_ptr()

    for name, module in list(model.named_modules()):
        for child_name, child in list(module.named_children()):
            if isinstance(child, nn.Linear) and not (tied and child is model.get_output_embeddings()):
                setattr(module, child_name, Int8Linear.from_linear(child))

    emb = model.get_input_embeddings()
    q, scale = quantize_rows(emb.weight)
    model.set_input_embeddings(Int8Embedding(q, scale, emb.padding_idx))
    if tied:
        model.lm_head = Int8Linear(q, scale, None)  # same storage as the embedding
    model.config.tie_word_embeddings = False  # nothing left for HF to re-tie

    seen, after = set(), 0
    for t in list(model.parameters()) + list(model.buffers()):
        if t.data_ptr() not in seen:
            seen.add(t.data_ptr())
            after += t.numel() * t.element_size()
    return {"bytes_before": before, "bytes_after": after}
