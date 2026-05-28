from functools import lru_cache

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # MiMo API
    mimo_api_key: str = ""
    mimo_api_base: str = "https://api.xiaomimimo.com/v1"
    mimo_tts_model: str = "mimo-v2.5-tts"
    mimo_tts_voice: str = "冰糖"
    mimo_tts_voice_warm_female: str = ""
    mimo_tts_voice_warm_male: str = ""
    mimo_tts_voice_bright_girl: str = ""
    mimo_tts_voice_warm_female_prompt: str = ""

    # LLM
    llm_provider: str = "mimo"
    llm_api_key: str = ""
    llm_model: str = "mimo-v2.5-pro"
    llm_api_base: str = "https://api.xiaomimimo.com/v1"
    llm_fallback_provider: str = "anthropic"
    llm_fallback_api_key: str = ""
    llm_fallback_model: str = "claude-sonnet-4-6"
    max_daily_tokens: int = 100000

    # NetEase
    netease_bridge_port: int = 3000

    # Paths
    data_dir: str = "./data"

    class Config:
        env_file = ".env"


@lru_cache()
def get_settings() -> Settings:
    return Settings()
