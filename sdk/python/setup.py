from setuptools import setup, find_packages

setup(
    name="llama-ultra",
    version="1.2.0",
    description="Python SDK for LLaMA Ultra — run AI models on any machine",
    long_description=open("README.md").read(),
    long_description_content_type="text/markdown",
    author="LLaMA Ultra",
    license="MIT",
    packages=find_packages(),
    python_requires=">=3.8",
    install_requires=[
        "httpx>=0.24.0",
        "sseclient-py>=1.7.2",
    ],
    extras_require={
        "openai": ["openai>=1.0.0"],
    },
    classifiers=[
        "Programming Language :: Python :: 3",
        "License :: OSI Approved :: MIT License",
        "Operating System :: OS Independent",
        "Topic :: Scientific/Engineering :: Artificial Intelligence",
    ],
)
